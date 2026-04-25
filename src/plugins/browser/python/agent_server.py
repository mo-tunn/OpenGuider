"""
agent_server.py
FastAPI HTTP server that wraps browser-use Agent.
Receives Step JSON, runs the agent, returns StepResult JSON.

Endpoints:
  GET  /health
  POST /execute
  POST /run-goal
  POST /pause
  POST /resume
  POST /abort
  GET  /screenshot

Bind: 127.0.0.1 only. Port read from PORT env var.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import sys
from typing import Any, Optional

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

from json_repair import patch_browser_use_agent_output_validation

# ── Disable browser-use telemetry immediately ─────────────────────────────────
os.environ["ANONYMIZED_TELEMETRY"] = "false"

load_dotenv()

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="[agent_server] %(levelname)s %(message)s",
)
logger = logging.getLogger("openguider.agent_server")

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="OpenGuider Browser Agent", version="1.0.0")

# ── Global agent state ────────────────────────────────────────────────────────
_current_agent = None
_current_browser = None
_current_run_task = None
_abort_requested = False
_agent_lock = asyncio.Lock()
_json_repair_patch_attempted = False


# ── Pydantic models ───────────────────────────────────────────────────────────

class StepContext(BaseModel):
    screenshot: str = ""
    notes: str = ""


class StepPayload(BaseModel):
    id: str
    type: str
    payload: dict[str, Any]
    context: StepContext = StepContext()
    trustLevel: str = "balanced"


class StepResult(BaseModel):
    stepId: str
    success: bool
    screenshot: str = ""
    message: str
    requiresHumanReview: bool = False
    error: Optional[str] = None


class GoalPayload(BaseModel):
    goal: str
    trustLevel: str = "balanced"
    maxSteps: int = 50


class GoalResult(BaseModel):
    success: bool
    summary: str = ""
    stepsCompleted: int = 0
    screenshotFinal: str = ""
    error: Optional[str] = None


def _coerce_string(value: Any) -> str:
    """Normalize nullable or non-string values for response models."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _get_env_first(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "")
        if value:
            return value
    return ""


def _get_history_screenshot(history: Any) -> str:
    """Return the latest non-empty screenshot string from browser-use history."""
    try:
        screenshots = history.screenshots()
    except Exception as exc:
        logger.debug("history screenshot lookup failed: %s", exc)
        return ""

    if not isinstance(screenshots, list):
        return ""

    for screenshot in reversed(screenshots):
        normalized = _coerce_string(screenshot)
        if normalized:
            return normalized
    return ""


def _is_rate_limited_error(*values: Any) -> bool:
    joined = " ".join(_coerce_string(value) for value in values if value)
    return bool(
        re.search(
            r"\b(429|413|RESOURCE_EXHAUSTED|rate limit|rate-limited|rate_limit_exceeded|quota exceeded|quota|tokens per minute|tpm|request too large)\b",
            joined,
            re.IGNORECASE,
        )
    )


def _extract_retry_delay_seconds(*values: Any) -> Optional[int]:
    joined = " ".join(_coerce_string(value) for value in values if value)
    match = re.search(r"retry(?:ing)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)s", joined, re.IGNORECASE)
    if not match:
        match = re.search(r"'retryDelay':\s*'(\d+)s'", joined)
    if not match:
        return None
    try:
        return max(1, int(float(match.group(1))))
    except (TypeError, ValueError):
        return None


def _format_rate_limit_summary(summary: str, details: str = "") -> str:
    if not _is_rate_limited_error(summary, details):
        return summary

    joined = " ".join(part for part in (summary, details) if part)
    if re.search(r"\b(413|tokens per minute|tpm|request too large)\b", joined, re.IGNORECASE):
        return "Browser task stopped because the selected AI model's token limit is too small for this browser page. Use a Groq model with browser-safe structured output support or reduce browser prompt size."

    retry_after = _extract_retry_delay_seconds(summary, details)
    message = "Browser task stopped because the AI provider quota was exceeded"
    if retry_after:
        message += f". Retry in about {retry_after} seconds."
    else:
        message += ". Please wait a moment and try again."
    return message


def _format_model_capability_summary(summary: str, details: str = "") -> str:
    joined = " ".join(part for part in (summary, details) if part)
    if re.search(r"messages\[\d+\]\.content must be a string", joined, re.IGNORECASE):
        return "Browser task stopped because the selected AI model does not support the screenshot-rich prompt format used for browser automation. A text-only fallback should be used for this provider/model."

    if re.search(r"no endpoints found that support image input", joined, re.IGNORECASE):
        return "Browser task stopped because the selected AI model does not accept image input. Browser automation should run in text-only mode for this provider/model."

    if re.search(r"response format `json_schema`|does not support response format `json_schema`", joined, re.IGNORECASE):
        return "Browser task stopped because the selected AI model does not support the structured output format required by browser automation."

    return summary


def _summarize_history_failure(history: Any) -> str:
    """Return a short diagnostic string when a browser-use run fails."""
    if history is None:
        return ""

    parts: list[str] = []

    try:
        last_action = history.last_action() if hasattr(history, "last_action") else None
        if last_action:
            parts.append(f"last_action={last_action}")
    except Exception as exc:
        logger.debug("history last_action lookup failed: %s", exc)

    try:
        errors = history.errors() if hasattr(history, "errors") else []
        compact_errors = [str(item) for item in (errors or []) if item][:3]
        if compact_errors:
            parts.append(f"errors={compact_errors}")
    except Exception as exc:
        logger.debug("history errors lookup failed: %s", exc)

    try:
        action_results = history.action_results() if hasattr(history, "action_results") else []
        if isinstance(action_results, list) and action_results:
            parts.append(f"action_results={action_results[-3:]}")
    except Exception as exc:
        logger.debug("history action_results lookup failed: %s", exc)

    return " | ".join(parts)


def _build_browser_task(task: str, *, autonomous: bool) -> str:
    """Wrap user intent with concrete completion criteria for browser-use."""
    base_task = _coerce_string(task).strip()
    if not base_task:
        return ""

    execution_mode = "autonomous goal run" if autonomous else "single guided browser step"
    guidance = [
        f"OpenGuider mode: {execution_mode}.",
        "Complete the user's request in the browser and call done as soon as the request is satisfied.",
        "Treat the current visible browser state as the source of truth, even if it changed because a human intervened.",
        "If a step was skipped or the user manually changed the page, reassess from the current page instead of retrying stale assumptions.",
        "Prefer stable actions: navigate directly, use visible search fields, then click clear targets.",
        "Avoid wandering or repeated scrolling once you already have enough information to answer.",
        "If the task asks for a count or list, stop exactly when you have enough distinct items.",
        "Prefer reading visible page content directly and calling done; only use extract when the answer cannot be gathered from the current page state.",
        "In the done text, summarize the outcome concisely with concrete findings instead of saying only that the task is complete.",
        "If product or search results are requested, include a numbered list of the found items and visible links or identifying details when available.",
        "If the website blocks progress with a captcha, login wall, or anti-bot check, call done with success=false and explain the blocker clearly.",
    ]
    return f"{base_task}\n\nExecution rules:\n- " + "\n- ".join(guidance)


def _build_agent_kwargs(task: str, llm: Any, browser: Any, hooks: Any, *, autonomous: bool) -> dict[str, Any]:
    done_guidance = (
        "Finish as soon as the request is fulfilled. "
        "When enough items are gathered, call done immediately with a concise numbered result list."
        if autonomous
        else "Finish as soon as the request is fulfilled. "
             "Do not continue exploring after you have enough evidence to answer."
    )

    agent_kwargs: dict[str, Any] = {
        "task": task,
        "llm": llm,
        "browser": browser,
        "max_actions_per_step": 3,
        "max_failures": 2,
        "use_thinking": False,
        "use_judge": False,
        "enable_planning": False,
        "final_response_after_failure": False,
        "llm_screenshot_size": (960, 600),
        "max_clickable_elements_length": 12000,
        "extend_system_message": (
            done_guidance
            + " Treat the live browser state as the source of truth after any skipped step or human intervention."
            + " Avoid using extract for short visible result lists unless direct page reading is insufficient."
            + " Do not rely on image input; operate in text-only mode."
        ),
        "use_vision": False,
    }
    if hooks:
        agent_kwargs["register_new_step_callback"] = hooks.on_model_output
    return agent_kwargs


# ── Helper: build LLM from env ────────────────────────────────────────────────

def _build_llm():
    """
    Build a LangChain-compatible LLM from environment variables injected by sidecar.js.
    Variables: OPENGUIDER_LLM_PROVIDER, OPENGUIDER_LLM_API_KEY, OPENGUIDER_LLM_MODEL
    Falls back to OPENAI_API_KEY if no explicit config.
    """
    provider = os.environ.get("OPENGUIDER_LLM_PROVIDER", "openai").lower()
    model    = os.environ.get("OPENGUIDER_LLM_MODEL", "")
    provider_api_keys = {
        "openai": ("OPENGUIDER_LLM_API_KEY", "OPENAI_API_KEY"),
        "openrouter": ("OPENGUIDER_LLM_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"),
        "anthropic": ("OPENGUIDER_LLM_API_KEY", "ANTHROPIC_API_KEY"),
        "google": ("OPENGUIDER_LLM_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "gemini": ("OPENGUIDER_LLM_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "groq": ("OPENGUIDER_LLM_API_KEY", "GROQ_API_KEY"),
    }
    env_names = provider_api_keys.get(provider, ("OPENGUIDER_LLM_API_KEY",))
    api_key = _get_env_first(*env_names)

    default_models = {
        "openai": "gpt-4o-mini",
        "openrouter": "openai/gpt-4o-mini",
        "anthropic": "claude-3-5-haiku-latest",
        "google": "gemini-1.5-flash",
        "gemini": "gemini-1.5-flash",
        "groq": "openai/gpt-oss-20b",
    }
    if provider not in default_models:
        supported = ", ".join(sorted(default_models.keys()))
        raise RuntimeError(f"Unsupported browser LLM provider '{provider}'. Supported providers: {supported}")

    if not model:
        model = default_models.get(provider, "gpt-4o-mini")

    if not api_key:
        names = ", ".join(env_names)
        raise RuntimeError(f"Missing API key for provider '{provider}'. Set one of: {names}")

    logger.info("Building LLM: provider=%s model=%s", provider, model)

    if provider in ("openai", "openrouter"):
        from browser_use import ChatOpenAI
        kwargs = {"model": model}
        if api_key:
            kwargs["api_key"] = api_key
        if provider == "openrouter":
            kwargs["base_url"] = "https://openrouter.ai/api/v1"
        return ChatOpenAI(**kwargs)

    if provider == "anthropic":
        from browser_use import ChatAnthropic
        kwargs = {"model": model}
        if api_key:
            kwargs["api_key"] = api_key
        return ChatAnthropic(**kwargs)

    if provider in ("google", "gemini"):
        from browser_use import ChatGoogle
        kwargs = {"model": model}
        if api_key:
            os.environ["GOOGLE_API_KEY"] = api_key
        return ChatGoogle(**kwargs)

    if provider == "groq":
        from browser_use import ChatGroq

        kwargs = {"model": model}
        if api_key:
            kwargs["api_key"] = api_key
        return ChatGroq(**kwargs)

    raise RuntimeError(f"Unsupported browser LLM provider '{provider}'")


def _ensure_browser_use_json_repair_patch() -> None:
    global _json_repair_patch_attempted
    if _json_repair_patch_attempted:
        return

    try:
        applied = patch_browser_use_agent_output_validation()
        logger.info("browser-use-agentoutput-json-repair %s", "enabled" if applied else "already-enabled")
    except Exception as exc:
        logger.warning("browser-use-agentoutput-json-repair failed: %s", exc)
    finally:
        _json_repair_patch_attempted = True


# ── Helper: capture screenshot ────────────────────────────────────────────────

async def _capture_screenshot() -> str:
    """Capture current browser screenshot as base64 PNG. Returns '' on failure."""
    global _current_browser
    try:
        if _current_browser is not None:
            screenshot_bytes = await _current_browser.take_screenshot()
            if screenshot_bytes:
                return _coerce_string(base64.b64encode(screenshot_bytes).decode("utf-8"))
    except Exception as exc:
        logger.debug("screenshot capture failed: %s", exc)
    return ""


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0"}


@app.post("/execute", response_model=StepResult)
async def execute(step: StepPayload):
    global _current_agent, _current_browser, _current_run_task, _abort_requested

    # Only one task at a time
    async with _agent_lock:
        from browser_use import Agent, Browser
        from hitl_hooks import HITLHooks
        _ensure_browser_use_json_repair_patch()

        callback_port = os.environ.get("CALLBACK_PORT", "")
        hooks = HITLHooks(f"http://127.0.0.1:{callback_port}/substep") if callback_port else None

        headless_env = os.environ.get("BROWSER_HEADLESS", "true")
        headless = headless_env.lower() not in ("false", "0", "no")

        browser = Browser(headless=headless)
        _current_browser = browser
        _abort_requested = False

        # Build the task from the payload
        instruction = step.payload.get("instruction", "")
        notes       = step.context.notes or ""
        task        = f"{instruction}\n\n{notes}".strip() if notes else instruction
        task = _build_browser_task(task, autonomous=False)

        try:
            llm = _build_llm()
        except Exception as exc:
            logger.error("LLM build failed: %s", exc)
            return StepResult(
                stepId=step.id,
                success=False,
                message="Failed to build LLM client",
                requiresHumanReview=True,
                error=str(exc),
            )

        agent_kwargs = _build_agent_kwargs(task, llm, browser, hooks, autonomous=False)

        agent = Agent(**agent_kwargs)
        _current_agent = agent

        screenshot_after = ""
        try:
            _current_run_task = asyncio.create_task(agent.run(max_steps=50, on_step_end=hooks.on_step_end if hooks else None))
            history = await _current_run_task
            success = history.is_successful() or history.is_done()
            message = history.final_result() or ("Task completed" if success else "Task did not complete")
            screenshot_after = _get_history_screenshot(history)
            return StepResult(
                stepId=step.id,
                success=bool(success),
                screenshot=_coerce_string(screenshot_after),
                message=str(message),
                requiresHumanReview=not bool(success),
            )
        except asyncio.CancelledError:
            screenshot_after = await _capture_screenshot()
            return StepResult(
                stepId=step.id,
                success=False,
                screenshot=_coerce_string(screenshot_after),
                message="Execution aborted by user" if _abort_requested else "Task was cancelled",
                requiresHumanReview=False,
            )
        except Exception as exc:
            logger.error("Agent run failed: %s", exc)
            screenshot_after = await _capture_screenshot()
            message = _format_rate_limit_summary(f"Agent error: {exc}", str(exc))
            message = _format_model_capability_summary(message, str(exc))
            return StepResult(
                stepId=step.id,
                success=False,
                screenshot=_coerce_string(screenshot_after),
                message=message,
                requiresHumanReview=True,
                error=str(exc),
            )
        finally:
            _current_agent = None
            _current_run_task = None
            _abort_requested = False
            if hooks:
                await hooks.close()
            try:
                await browser.close()
            except Exception:
                pass
            _current_browser = None


@app.post("/run-goal", response_model=GoalResult)
async def run_goal(payload: GoalPayload):
    global _current_agent, _current_browser, _current_run_task, _abort_requested

    async with _agent_lock:
        from browser_use import Agent, Browser
        from hitl_hooks import HITLHooks
        _ensure_browser_use_json_repair_patch()

        callback_port = os.environ.get("CALLBACK_PORT", "")
        hooks = HITLHooks(f"http://127.0.0.1:{callback_port}/substep") if callback_port else None

        headless_env = os.environ.get("BROWSER_HEADLESS", "true")
        headless = headless_env.lower() not in ("false", "0", "no")

        browser = Browser(headless=headless)
        _current_browser = browser
        _abort_requested = False

        try:
            llm = _build_llm()
        except Exception as exc:
            logger.error("LLM build failed for run-goal: %s", exc)
            return GoalResult(
                success=False,
                summary="Failed to build LLM client",
                stepsCompleted=0,
                screenshotFinal="",
                error=str(exc),
            )

        agent_kwargs = _build_agent_kwargs(
            _build_browser_task(payload.goal, autonomous=True),
            llm,
            browser,
            hooks,
            autonomous=True,
        )

        agent = Agent(**agent_kwargs)
        screenshot_final = ""
        try:
            replan_attempts = 0
            max_replans = 5
            while True:
                if replan_attempts > 0:
                    logger.info("run-goal-replan-attempt %s", replan_attempts)
                    replanned_goal = (
                        payload.goal
                        + "\n\nRe-plan now from the current browser state."
                        + " The previous action was intentionally interrupted by the user."
                        + " Do not restart from stale assumptions."
                    )
                    agent_kwargs = _build_agent_kwargs(
                        _build_browser_task(replanned_goal, autonomous=True),
                        llm,
                        browser,
                        hooks,
                        autonomous=True,
                    )
                    agent = Agent(**agent_kwargs)

                _current_agent = agent
                _current_run_task = asyncio.create_task(
                    agent.run(
                        max_steps=max(1, int(payload.maxSteps)),
                        on_step_end=hooks.on_step_end if hooks else None,
                    )
                )
                try:
                    history = await _current_run_task
                    success = history.is_successful() or history.is_done()
                    summary = history.final_result() or ("Task completed" if success else "Task did not complete")
                    screenshot_final = _get_history_screenshot(history)
                    diagnostics = ""

                    action_results = history.action_results() if hasattr(history, "action_results") else []
                    steps_completed = len(action_results) if isinstance(action_results, list) else 0

                    if not success:
                        diagnostics = _summarize_history_failure(history)
                        summary = _format_rate_limit_summary(str(summary), diagnostics)
                        summary = _format_model_capability_summary(summary, diagnostics)
                        if diagnostics:
                            logger.warning("run-goal incomplete: %s | %s", summary, diagnostics)
                        else:
                            logger.warning("run-goal incomplete: %s", summary)

                    return GoalResult(
                        success=bool(success),
                        summary=str(summary),
                        stepsCompleted=steps_completed,
                        screenshotFinal=_coerce_string(screenshot_final),
                        error=diagnostics if not success and diagnostics else None,
                    )
                except Exception as exc:
                    message = str(exc)
                    if message == "HITL_REPLAN":
                        replan_attempts += 1
                        if replan_attempts > max_replans:
                            screenshot_final = await _capture_screenshot()
                            return GoalResult(
                                success=False,
                                summary="Re-plan limit reached. Please review the task and try again.",
                                stepsCompleted=0,
                                screenshotFinal=_coerce_string(screenshot_final),
                                error="replan_limit_reached",
                            )
                        continue
                    raise
                finally:
                    _current_run_task = None
                    _current_agent = None
        except asyncio.CancelledError:
            screenshot_final = await _capture_screenshot()
            return GoalResult(
                success=False,
                summary="Execution aborted by user" if _abort_requested else "Task was cancelled",
                stepsCompleted=0,
                screenshotFinal=_coerce_string(screenshot_final),
            )
        except Exception as exc:
            message = str(exc)
            if message == "HITL_ABORT":
                screenshot_final = await _capture_screenshot()
                return GoalResult(
                    success=False,
                    summary="Execution aborted by user",
                    stepsCompleted=0,
                    screenshotFinal=_coerce_string(screenshot_final),
                )

            logger.error("run-goal failed: %s", exc)
            screenshot_final = await _capture_screenshot()
            message = _format_rate_limit_summary(f"Agent error: {exc}", str(exc))
            message = _format_model_capability_summary(message, str(exc))
            return GoalResult(
                success=False,
                summary=message,
                stepsCompleted=0,
                screenshotFinal=_coerce_string(screenshot_final),
                error=message,
            )
        finally:
            _current_agent = None
            _current_run_task = None
            _abort_requested = False
            if hooks:
                await hooks.close()
            try:
                await browser.close()
            except Exception:
                pass
            _current_browser = None


@app.post("/pause")
async def pause():
    if _current_agent is not None:
        try:
            await _current_agent.pause()
        except Exception as exc:
            logger.warning("pause failed: %s", exc)
    return {"ok": True}


@app.post("/resume")
async def resume():
    if _current_agent is not None:
        try:
            await _current_agent.resume()
        except Exception as exc:
            logger.warning("resume failed: %s", exc)
    return {"ok": True}


@app.post("/abort")
async def abort():
    global _current_agent, _current_browser, _current_run_task, _abort_requested
    _abort_requested = True
    if _current_run_task is not None and not _current_run_task.done():
        _current_run_task.cancel()
    if _current_agent is not None:
        try:
            # browser-use Agent doesn't have a direct abort; closing the browser stops it
            if _current_browser is not None:
                await _current_browser.close()
        except Exception as exc:
            logger.warning("abort close failed: %s", exc)
        _current_agent = None
        _current_browser = None
    return {"ok": True}


@app.get("/screenshot")
async def screenshot():
    data = await _capture_screenshot()
    return {"screenshot": data}


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    logger.info("Starting agent_server on 127.0.0.1:%d", port)

    # Add the directory containing this script to sys.path so that
    # `from hitl_hooks import HITLHooks` works regardless of CWD.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
