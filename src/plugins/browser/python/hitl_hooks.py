"""
hitl_hooks.py
Implements browser-use on_step_start / on_step_end callbacks that report
sub-step progress back to Node.js over a secondary HTTP endpoint.

The callback URL is set to http://127.0.0.1:{CALLBACK_PORT}/substep.
All failures are swallowed — the hook must never block browser-use.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("openguider.hitl_hooks")

# The approval UI may wait up to ~120s for a human decision in supervised mode.
# Keep the callback open slightly longer so Approve / Re-plan / Abort decisions
# actually reach the Python side before it falls back to "continue".
CALLBACK_TIMEOUT = float(os.environ.get("OPENGUIDER_HITL_TIMEOUT_SECONDS", "125"))


class HITLHooks:
    """Sends sub-step progress events to the Node.js callback endpoint."""

    def __init__(self, callback_url: str) -> None:
        self._callback_url = callback_url
        self._client = httpx.AsyncClient(timeout=CALLBACK_TIMEOUT)
        self._active_step_number = 0
        self._step_descriptions: dict[int, str] = {}

    def _truncate(self, value: Any, limit: int = 80) -> str:
        text = str(value or "").strip()
        if len(text) <= limit:
            return text
        return text[: limit - 3] + "..."

    def _get_action_type_and_payload(self, action_data: dict | str) -> tuple[str, dict | str]:
        if isinstance(action_data, dict) and action_data:
            action_type = next(iter(action_data.keys()))
            return str(action_type), action_data.get(action_type) or {}
        if isinstance(action_data, str):
            return "action", action_data
        return "action", {}

    def _get_selector_node(self, browser_state_summary, index: Any):
        try:
            selector_map = browser_state_summary.dom_state.selector_map or {}
            return selector_map.get(int(index))
        except Exception:  # noqa: BLE001
            return None

    def _is_sensitive_target(self, node) -> bool:
        attrs = getattr(node, "attributes", {}) or {}
        joined = " ".join(
            str(attrs.get(key, ""))
            for key in ("type", "name", "id", "placeholder", "aria-label", "autocomplete")
        ).lower()
        if attrs.get("type", "").lower() == "password":
            return True
        markers = ("password", "passcode", "otp", "token", "secret", "api", "key", "cvv", "cvc", "ssn")
        return any(marker in joined for marker in markers)

    def _format_text_value(self, text: Any, *, mask: bool = False) -> str:
        normalized = str(text or "")
        if mask and normalized:
            return "<sensitive>"
        shortened = self._truncate(normalized, 50)
        return f'"{shortened}"' if shortened else '""'

    def _describe_selector_node(self, node, index: Any = None) -> str:
        if node is None:
            return "the highlighted target" if index is not None else "the current page"

        attrs = getattr(node, "attributes", {}) or {}
        tag = getattr(node, "tag_name", None) or getattr(node, "node_name", "element")
        tag = str(tag).lower()

        label_candidates = [
            getattr(getattr(node, "ax_node", None), "name", None),
            attrs.get("aria-label"),
            attrs.get("placeholder"),
            attrs.get("name"),
            attrs.get("id"),
            attrs.get("title"),
            attrs.get("value"),
            getattr(node, "get_all_children_text", lambda: "")(),
        ]
        label = next((self._truncate(value, 60) for value in label_candidates if str(value or "").strip()), "")

        if tag == "button":
            descriptor = "button"
        elif tag in ("input", "textarea"):
            descriptor = "field"
        elif tag == "select":
            descriptor = "dropdown"
        elif tag == "a":
            descriptor = "link"
        else:
            descriptor = tag or "element"

        if label:
            return f'{descriptor} "{label}"'
        return f"the {descriptor}"

    def _build_action_description(self, browser_state_summary, action_data: dict | str) -> str:
        action_type, payload = self._get_action_type_and_payload(action_data)
        if isinstance(payload, str):
            return self._truncate(payload, 140)

        payload = payload if isinstance(payload, dict) else {}
        index = payload.get("index")
        node = self._get_selector_node(browser_state_summary, index) if index is not None else None
        target = self._describe_selector_node(node, index)
        lower_action = action_type.lower()

        if lower_action in ("navigate", "go_to_url", "open_url"):
            return f'Open {self._truncate(payload.get("url", "the requested page"), 120)}'

        if lower_action in ("click", "click_element", "click_element_by_index"):
            if payload.get("coordinate_x") is not None and payload.get("coordinate_y") is not None:
                return "Click the highlighted spot on the page"
            return f"Click {target}"

        if lower_action in ("input_text", "input", "type", "type_text"):
            text_value = self._format_text_value(payload.get("text"), mask=self._is_sensitive_target(node))
            if payload.get("clear", True) and not str(payload.get("text", "")):
                return f"Clear {target if node is not None else 'the highlighted field'}"
            if node is None:
                return f"Type {text_value} into the highlighted field"
            return f"Type {text_value} into {target}"

        if lower_action in ("select_dropdown", "select", "select_dropdown_option"):
            option_text = self._format_text_value(payload.get("text") or payload.get("value"))
            if node is None:
                return f"Select {option_text} in the highlighted field"
            return f"Select {option_text} in {target}"

        if lower_action == "scroll":
            direction = "down" if payload.get("down", True) else "up"
            pages = payload.get("pages") or payload.get("num_pages") or 1
            if index is not None:
                return f"Scroll inside {target} {direction} by {pages} page(s)"
            return f"Scroll the current page {direction} by {pages} page(s)"

        if lower_action == "send_keys":
            return f'Send {self._format_text_value(payload.get("keys"))} to the current page'

        if lower_action in ("upload_file", "upload"):
            file_path = os.path.basename(str(payload.get("path") or payload.get("file_path") or "file"))
            return f'Upload "{self._truncate(file_path, 50)}" using {target}'

        if lower_action in ("wait",):
            seconds = payload.get("seconds", 0)
            return f"Wait for {seconds} second(s)"

        return self._truncate(f"{action_type}: {payload}", 160)

    def _dump_action_candidate(self, candidate) -> dict | str:
        if candidate is None:
            return {}

        if hasattr(candidate, "model_dump"):
            try:
                dumped = candidate.model_dump(exclude_none=True, mode="json")
            except TypeError:
                dumped = candidate.model_dump()
            if isinstance(dumped, dict):
                return dumped
            if dumped is not None:
                return str(dumped)

        if isinstance(candidate, dict):
            return {k: v for k, v in candidate.items() if v is not None}

        if isinstance(candidate, str):
            return candidate

        return str(candidate)

    def _extract_action_data(self, agent_output) -> dict | str:
        action_data = {}

        if agent_output and hasattr(agent_output, "action") and agent_output.action:
            for action_candidate in agent_output.action:
                dumped = self._dump_action_candidate(action_candidate)
                if dumped:
                    return dumped

        if isinstance(agent_output, dict):
            actions = agent_output.get("action")
            if isinstance(actions, list):
                for action_candidate in actions:
                    dumped = self._dump_action_candidate(action_candidate)
                    if dumped:
                        return dumped

        return action_data

    def _has_action_data(self, action_data: dict | str) -> bool:
        if isinstance(action_data, dict):
            return bool(action_data)
        if isinstance(action_data, str):
            return bool(action_data.strip())
        return bool(action_data)

    def _extract_completed_step(self, agent) -> tuple[int, dict | str]:
        if agent is None:
            return self._active_step_number, {}

        state = getattr(agent, "state", None)
        model_output = getattr(state, "last_model_output", None)
        if model_output is not None:
            action_data = self._extract_action_data(model_output)
            if self._has_action_data(action_data):
                step_number = int(self._active_step_number or getattr(state, "n_steps", 0) or 0)
                return step_number, action_data

        history = getattr(agent, "history", None)
        if history is not None and hasattr(history, "last_action"):
            try:
                action_data = history.last_action()
                if self._has_action_data(action_data):
                    items = getattr(history, "history", None)
                    if items:
                        last_item = items[-1]
                        metadata = getattr(last_item, "metadata", None)
                        step_number = int(self._active_step_number or getattr(metadata, "step_number", 0) or 0)
                    else:
                        step_number = self._active_step_number
                    return step_number, action_data
            except Exception:
                pass

        items = getattr(history, "history", None)
        if not items:
            return self._active_step_number, {}

        last_item = items[-1]
        metadata = getattr(last_item, "metadata", None)
        step_number = int(self._active_step_number or getattr(metadata, "step_number", 0) or 0)
        action_data = self._extract_action_data(getattr(last_item, "model_output", None))
        return step_number, action_data

    def _rewrite_action_to_wait(self, agent_output) -> bool:
        """Replace the current action list with a no-op wait so "skip" is real."""
        try:
            actions = getattr(agent_output, "action", None)
            if not actions:
                return False

            action_model_cls = type(actions[0])
            wait_action = action_model_cls.model_validate({"wait": {"seconds": 0}})
            agent_output.action = [wait_action]
            return True
        except Exception as exc:  # noqa: BLE001
            logger.debug("failed to rewrite skipped action to wait(): %s", exc)
            return False

    async def on_model_output(self, _browser_state_summary, agent_output, step_number: int) -> None:
        """Called by browser-use after the LLM chooses the next step."""
        try:
            self._active_step_number = int(step_number or 0)
            action_data = self._extract_action_data(agent_output)
            description = self._build_action_description(_browser_state_summary, action_data)
            self._step_descriptions[self._active_step_number] = description

            payload = {
                "event": "substep_start",
                "stepNumber": self._active_step_number,
                "action": action_data,
                "description": description,
            }
            logger.info("[hitl-hooks] substep_start step=%s action=%s", self._active_step_number, action_data)
            decision = await self._post(payload)
            if decision == "abort":
                raise RuntimeError("HITL_ABORT")
            if decision == "replan":
                raise RuntimeError("HITL_REPLAN")
            if decision == "skip":
                if self._rewrite_action_to_wait(agent_output):
                    logger.info("[hitl-hooks] skip requested for step=%s -> rewritten to wait(0)", self._active_step_number)
                else:
                    logger.warning(
                        "[hitl-hooks] skip requested for step=%s but action rewrite failed; continuing original action",
                        self._active_step_number,
                    )
        except Exception as exc:  # noqa: BLE001
            logger.debug("on_model_output callback failed (non-fatal): %s", exc)
            if str(exc) in ("HITL_ABORT", "HITL_REPLAN"):
                raise

    async def on_step_end(self, agent) -> None:
        """Called by browser-use after each internal action."""
        try:
            step_number, action_data = self._extract_completed_step(agent)
            if not self._has_action_data(action_data):
                logger.debug("[hitl-hooks] ignoring empty substep_end step=%s", step_number)
                return
            payload = {
                "event": "substep_end",
                "stepNumber": step_number,
                "action": action_data,
                "description": self._step_descriptions.get(step_number, ""),
            }
            logger.info("[hitl-hooks] substep_end step=%s action=%s", step_number, action_data)
            await self._post(payload)
            if step_number == self._active_step_number:
                self._active_step_number = 0
            if step_number in self._step_descriptions:
                del self._step_descriptions[step_number]
        except Exception as exc:  # noqa: BLE001
            logger.debug("on_step_end callback failed (non-fatal): %s", exc)

    async def _post(self, payload: dict) -> str:
        """POST payload to the Node.js callback endpoint. Returns decision."""
        try:
            response = await self._client.post(self._callback_url, json=payload)
            if response.is_success:
                try:
                    data = response.json()
                    decision = str(data.get("decision", "continue"))
                    if decision in ("continue", "skip", "replan", "abort"):
                        return decision
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            logger.debug("HITL callback HTTP error (non-fatal): %s", exc)
        return "continue"

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        try:
            await self._client.aclose()
        except Exception:  # noqa: BLE001
            pass
