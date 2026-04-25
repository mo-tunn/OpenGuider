from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import ValidationError

logger = logging.getLogger("openguider.agent_server.json_repair")

_CODE_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def _decode_json_input(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def _strip_json_wrappers(text: str) -> str:
    value = text.strip().lstrip("\ufeff")
    fenced = _CODE_FENCE_RE.search(value)
    if fenced:
        value = fenced.group(1).strip()
    value = value.replace("<json>", "").replace("</json>", "").strip()
    return value


def _extract_probable_json_object(text: str) -> str:
    start = text.find("{")
    if start < 0:
        return text.strip()

    in_string = False
    escape = False
    stack: list[str] = []
    last_complete = -1

    for index, char in enumerate(text[start:], start):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            stack.append("}")
        elif char == "[":
            stack.append("]")
        elif char in ("}", "]"):
            if stack and char == stack[-1]:
                stack.pop()
                if not stack:
                    last_complete = index
                    break

    if last_complete >= start:
        return text[start : last_complete + 1].strip()
    return text[start:].strip()


def _balance_json_candidate(text: str) -> str:
    in_string = False
    escape = False
    expected_closers: list[str] = []
    output: list[str] = []

    for char in text:
        if in_string:
            output.append(char)
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            output.append(char)
            continue

        if char == "{":
            expected_closers.append("}")
            output.append(char)
            continue

        if char == "[":
            expected_closers.append("]")
            output.append(char)
            continue

        if char in ("}", "]"):
            if expected_closers and expected_closers[-1] == char:
                expected_closers.pop()
                output.append(char)
            continue

        output.append(char)

    if in_string:
        output.append('"')

    balanced = "".join(output)
    balanced = _TRAILING_COMMA_RE.sub(r"\1", balanced)
    if expected_closers:
        balanced = balanced.rstrip()
        balanced += "".join(reversed(expected_closers))
    return balanced.strip()


def _normalize_agent_output_payload(payload: Any) -> Any:
    if isinstance(payload, list):
        payload = {"action": payload}

    if not isinstance(payload, dict):
        return payload

    current_state = payload.get("current_state")
    if isinstance(current_state, dict):
        payload.setdefault("thinking", current_state.get("thinking"))
        payload.setdefault("evaluation_previous_goal", current_state.get("evaluation_previous_goal"))
        payload.setdefault("memory", current_state.get("memory"))
        payload.setdefault("next_goal", current_state.get("next_goal"))

    if "action" not in payload and isinstance(payload.get("actions"), list):
        payload["action"] = payload.get("actions")

    if isinstance(payload.get("action"), dict):
        payload["action"] = [payload["action"]]

    payload.setdefault("evaluation_previous_goal", "")
    payload.setdefault("memory", "")
    payload.setdefault("next_goal", "")
    return payload


def repair_agent_output_payload(raw_text: Any) -> Any:
    source = _strip_json_wrappers(_decode_json_input(raw_text))
    candidates: list[str] = []

    def push(candidate: str) -> None:
        normalized = candidate.strip()
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    push(source)
    extracted = _extract_probable_json_object(source)
    push(extracted)
    push(_balance_json_candidate(extracted))
    push(_balance_json_candidate(source))

    for candidate in candidates:
        try:
            return _normalize_agent_output_payload(json.loads(candidate))
        except json.JSONDecodeError:
            continue

    raise ValueError("Could not repair malformed AgentOutput JSON")


def patch_browser_use_agent_output_validation() -> bool:
    from browser_use.agent.views import AgentOutput

    if getattr(AgentOutput, "_openguider_json_repair_patched", False):
        return False

    original_validate_json = AgentOutput.model_validate_json.__func__

    def repaired_model_validate_json(cls, json_data: Any, *args, **kwargs):
        try:
            return original_validate_json(cls, json_data, *args, **kwargs)
        except ValidationError as error:
            error_text = str(error)
            if "json_invalid" not in error_text and "Invalid JSON" not in error_text:
                raise

            repaired_payload = repair_agent_output_payload(json_data)
            logger.warning(
                "Recovered malformed AgentOutput JSON for %s",
                getattr(cls, "__name__", "AgentOutput"),
            )
            return cls.model_validate(repaired_payload)

    AgentOutput.model_validate_json = classmethod(repaired_model_validate_json)
    AgentOutput._openguider_json_repair_patched = True
    return True


__all__ = [
    "patch_browser_use_agent_output_validation",
    "repair_agent_output_payload",
]
