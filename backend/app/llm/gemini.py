"""Google Gemini over its REST API (streamGenerateContent with server-sent events).

Written against the REST API directly instead of the SDK so the wire format is
visible and the provider can be tested with a fake HTTP transport.
"""
from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator

import httpx

from .base import (
    ChatMessage,
    LLMError,
    LLMEvent,
    TextDelta,
    ToolCall,
    ToolSpec,
    TurnEnd,
    kind_for_status,
)

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

# Gemini 3 models attach an encrypted "thought signature" to the first function
# call of a step and reject the next request if it is missing. We normally echo
# the model's own parts back untouched, which keeps the signature. This
# documented placeholder is only used when replaying a tool call that a
# *different* provider produced (after a fallback).
SKIP_SIGNATURE = "skip_thought_signature_validator"

_BLOCKED_REASONS = {"SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"}
_MALFORMED_REASONS = {"MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"}


class GeminiProvider:
    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str,
        client: httpx.AsyncClient,
        max_output_tokens: int = 4096,
        thinking_level: str = "",
        base_url: str = BASE_URL,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.client = client
        self.max_output_tokens = max_output_tokens
        self.thinking_level = thinking_level
        self.base_url = base_url.rstrip("/")

    # ---- request building -------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}

    def _contents(self, messages: list[ChatMessage]) -> list[dict[str, Any]]:
        contents: list[dict[str, Any]] = []
        for msg in messages:
            if msg.role == "user":
                contents.append({"role": "user", "parts": [{"text": msg.text}]})
            elif msg.role == "assistant":
                if msg.raw is not None and msg.raw_provider == self.name:
                    parts = msg.raw
                else:
                    parts = []
                    if msg.text:
                        parts.append({"text": msg.text})
                    for index, call in enumerate(msg.tool_calls):
                        function_call: dict[str, Any] = {"name": call.name, "args": call.args}
                        if call.native_id:
                            function_call["id"] = call.native_id
                        part: dict[str, Any] = {"functionCall": function_call}
                        if index == 0:
                            part["thoughtSignature"] = SKIP_SIGNATURE
                        parts.append(part)
                if parts:
                    contents.append({"role": "model", "parts": parts})
            elif msg.role == "tool":
                # All results of one step go in a single turn, in call order.
                parts = []
                for output in msg.tool_outputs:
                    response: dict[str, Any] = {
                        "name": output.call.name,
                        "response": output.content,
                    }
                    if output.call.native_id:
                        response["id"] = output.call.native_id
                    parts.append({"functionResponse": response})
                if parts:
                    contents.append({"role": "user", "parts": parts})
        return contents

    @staticmethod
    def _declaration(tool: ToolSpec) -> dict[str, Any]:
        declaration: dict[str, Any] = {"name": tool.name, "description": tool.description}
        # Gemini rejects an object schema with no properties, so omit it.
        if tool.parameters.get("properties"):
            declaration["parameters"] = tool.parameters
        return declaration

    def build_body(
        self,
        system: str,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        tool_choice: str | None = None,
    ) -> dict[str, Any]:
        generation_config: dict[str, Any] = {"maxOutputTokens": self.max_output_tokens}
        if self.thinking_level:
            generation_config["thinkingConfig"] = {"thinkingLevel": self.thinking_level.upper()}
        body: dict[str, Any] = {
            "contents": self._contents(messages),
            "generationConfig": generation_config,
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if tools:
            body["tools"] = [{"functionDeclarations": [self._declaration(t) for t in tools]}]
            if tool_choice:
                # ANY with one allowed name: the model must call exactly that function.
                body["toolConfig"] = {
                    "functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": [tool_choice]}
                }
        return body

    # ---- errors -----------------------------------------------------------

    def _error(self, status: int, payload: Any) -> LLMError:
        detail = ""
        retry_after: float | None = None
        if isinstance(payload, list) and payload:
            payload = payload[0]
        if isinstance(payload, dict):
            err = payload.get("error") or {}
            detail = str(err.get("message") or "")
            for item in err.get("details") or []:
                match = re.fullmatch(r"([\d.]+)s", str(item.get("retryDelay", "")))
                if match:
                    retry_after = float(match.group(1))
        kind = kind_for_status(status)
        if status == 400 and "api key" in detail.lower():
            kind = "auth"
        if kind == "auth":
            text = "Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env."
        elif kind == "model":
            text = (
                f"Gemini has no model called '{self.model}'. Set GEMINI_MODEL in backend/.env "
                "to a current one; `python -m app.doctor` lists them."
            )
        elif kind == "rate_limit":
            wait = f" Try again in about {int(retry_after) + 1} seconds." if retry_after else ""
            text = f"Gemini's free quota is used up for the moment.{wait}"
        elif kind == "server":
            text = "Gemini is having trouble right now. Try again in a moment."
        else:
            text = f"Gemini rejected the request: {detail or f'HTTP {status}'}"
        return LLMError(text, kind=kind, status=status, retry_after=retry_after)

    # ---- streaming --------------------------------------------------------

    async def stream(
        self,
        system: str,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        context: dict[str, Any] | None = None,
        tool_choice: str | None = None,
    ) -> AsyncIterator[LLMEvent]:
        url = f"{self.base_url}/models/{self.model}:streamGenerateContent?alt=sse"
        body = self.build_body(system, messages, tools, tool_choice)

        text_chunks: list[str] = []
        raw_parts: list[dict[str, Any]] = []
        calls: list[ToolCall] = []
        finish_reason = ""
        usage: dict[str, int] = {}

        try:
            async with self.client.stream(
                "POST", url, json=body, headers=self._headers()
            ) as response:
                if response.status_code != 200:
                    raw = await response.aread()
                    try:
                        payload = json.loads(raw)
                    except ValueError:
                        payload = None
                    raise self._error(response.status_code, payload)

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if "error" in chunk:
                        code = int(chunk["error"].get("code") or 500)
                        raise self._error(code, chunk)
                    block = (chunk.get("promptFeedback") or {}).get("blockReason")
                    if block:
                        raise LLMError(
                            "Gemini declined to answer that request.", kind="blocked"
                        )
                    candidates = chunk.get("candidates") or []
                    if candidates:
                        candidate = candidates[0]
                        for part in (candidate.get("content") or {}).get("parts") or []:
                            if part.get("thought"):
                                continue  # a summary of the model's reasoning, not the answer
                            if "functionCall" in part:
                                function_call = part["functionCall"] or {}
                                native_id = function_call.get("id")
                                calls.append(
                                    ToolCall(
                                        id=native_id or f"call_{len(calls) + 1}",
                                        name=str(function_call.get("name") or ""),
                                        args=dict(function_call.get("args") or {}),
                                        native_id=native_id,
                                    )
                                )
                            elif part.get("text"):
                                text_chunks.append(part["text"])
                                yield TextDelta(part["text"])
                            raw_parts.append(part)
                        finish_reason = candidate.get("finishReason") or finish_reason
                    meta = chunk.get("usageMetadata")
                    if meta:
                        usage = {
                            "input_tokens": int(meta.get("promptTokenCount") or 0),
                            "output_tokens": int(meta.get("candidatesTokenCount") or 0),
                            "total_tokens": int(meta.get("totalTokenCount") or 0),
                        }
        except httpx.TimeoutException as exc:
            raise LLMError("Gemini took too long to respond.", kind="network") from exc
        except httpx.HTTPError as exc:
            raise LLMError(
                "Couldn't reach Gemini. Check the internet connection.", kind="network"
            ) from exc

        text = "".join(text_chunks)
        if not text and not calls:
            if finish_reason in _BLOCKED_REASONS:
                raise LLMError("Gemini declined to answer that request.", kind="blocked")
            if finish_reason in _MALFORMED_REASONS:
                raise LLMError("Gemini produced a tool call it couldn't finish.", kind="server")
            if finish_reason == "MAX_TOKENS":
                raise LLMError(
                    "Gemini ran out of output tokens before answering. "
                    "Raise LLM_MAX_OUTPUT_TOKENS in backend/.env.",
                    kind="bad_request",
                )

        yield TurnEnd(
            ChatMessage(
                role="assistant",
                text=text,
                tool_calls=calls,
                raw=_merge_text_parts(raw_parts),
                raw_provider=self.name,
            ),
            usage,
        )

    async def list_models(self) -> list[str]:
        """Model ids this key can use for chat. Used by `python -m app.doctor`."""
        response = await self.client.get(
            f"{self.base_url}/models", headers=self._headers(), params={"pageSize": 200}
        )
        if response.status_code != 200:
            try:
                payload = response.json()
            except ValueError:
                payload = None
            raise self._error(response.status_code, payload)
        names = []
        for model in response.json().get("models") or []:
            if "generateContent" in (model.get("supportedGenerationMethods") or []):
                names.append(str(model.get("name", "")).removeprefix("models/"))
        return sorted(names)


def _merge_text_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join the many small text chunks of a stream into one part.

    Any part carrying extra fields (a thoughtSignature, a functionCall) is kept
    exactly as received, because Gemini validates those on the next request.
    """
    merged: list[dict[str, Any]] = []
    for part in parts:
        plain = set(part.keys()) == {"text"}
        if plain and merged and set(merged[-1].keys()) == {"text"}:
            merged[-1] = {"text": merged[-1]["text"] + part["text"]}
        elif plain and not part["text"]:
            continue
        else:
            merged.append(dict(part))
    return merged
