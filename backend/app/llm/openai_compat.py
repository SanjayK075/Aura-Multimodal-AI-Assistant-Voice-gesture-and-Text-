"""Any server that speaks the OpenAI chat-completions format.

Groq is the default use, but the same class works with OpenRouter, Ollama,
LM Studio and Gemini's OpenAI-compatible endpoint: only the base URL, key and
model change.
"""
from __future__ import annotations

import json
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
    parse_retry_after,
)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"


class OpenAICompatProvider:
    def __init__(
        self,
        name: str,
        base_url: str,
        api_key: str,
        model: str,
        client: httpx.AsyncClient,
        # Merged into every request body. The output-token limit goes here
        # because servers disagree on its name (max_tokens vs max_completion_tokens).
        extra_body: dict[str, Any] | None = None,
        label: str | None = None,
        env_prefix: str | None = None,
    ) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.client = client
        self.extra_body = extra_body or {}
        self.label = label or name.capitalize()
        self.env_prefix = env_prefix or name.upper()

    # ---- request building -------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _messages(self, system: str, messages: list[ChatMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if system:
            out.append({"role": "system", "content": system})
        for msg in messages:
            if msg.role == "user":
                out.append({"role": "user", "content": msg.text})
            elif msg.role == "assistant":
                if msg.raw is not None and msg.raw_provider == self.name:
                    out.append(msg.raw)
                    continue
                item: dict[str, Any] = {"role": "assistant", "content": msg.text or None}
                if msg.tool_calls:
                    item["tool_calls"] = [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": json.dumps(call.args)},
                        }
                        for call in msg.tool_calls
                    ]
                if item["content"] is None and not msg.tool_calls:
                    continue
                out.append(item)
            elif msg.role == "tool":
                for output in msg.tool_outputs:
                    out.append(
                        {
                            "role": "tool",
                            "tool_call_id": output.call.id,
                            "name": output.call.name,
                            "content": json.dumps(output.content, ensure_ascii=False),
                        }
                    )
        return out

    def build_body(
        self, system: str, messages: list[ChatMessage], tools: list[ToolSpec]
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": self._messages(system, messages),
            "stream": True,
        }
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in tools
            ]
            body["tool_choice"] = "auto"
        body.update(self.extra_body)
        return body

    # ---- errors -----------------------------------------------------------

    def _error(self, status: int, payload: Any, retry_after: float | None = None) -> LLMError:
        detail, code = "", ""
        if isinstance(payload, dict):
            err = payload.get("error")
            if isinstance(err, dict):
                detail = str(err.get("message") or "")
                code = str(err.get("code") or err.get("type") or "")
            elif isinstance(err, str):
                detail = err
        kind = kind_for_status(status)
        lowered = f"{detail} {code}".lower()
        if "tool_use_failed" in lowered or "failed to call a function" in lowered:
            # The model wrote a tool call the server couldn't parse. Worth one retry.
            return LLMError(
                f"{self.label} produced a tool call it couldn't finish.",
                kind="server",
                status=status,
            )
        if "decommissioned" in lowered or "model_not_found" in lowered or (
            "model" in lowered and "does not exist" in lowered
        ):
            kind = "model"
        if kind == "auth":
            text = f"{self.label} rejected the API key. Check {self.env_prefix}_API_KEY in backend/.env."
        elif kind == "model":
            text = (
                f"{self.label} has no model called '{self.model}'. Set {self.env_prefix}_MODEL in "
                "backend/.env to a current one; `python -m app.doctor` lists them."
            )
        elif kind == "rate_limit":
            wait = f" Try again in about {int(retry_after) + 1} seconds." if retry_after else ""
            text = f"{self.label}'s free quota is used up for the moment.{wait}"
        elif kind == "server":
            text = f"{self.label} is having trouble right now. Try again in a moment."
        else:
            text = f"{self.label} rejected the request: {detail or f'HTTP {status}'}"
        return LLMError(text, kind=kind, status=status, retry_after=retry_after)

    # ---- streaming --------------------------------------------------------

    async def stream(
        self,
        system: str,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        context: dict[str, Any] | None = None,
    ) -> AsyncIterator[LLMEvent]:
        url = f"{self.base_url}/chat/completions"
        body = self.build_body(system, messages, tools)

        text_chunks: list[str] = []
        # Tool calls arrive in fragments keyed by index; arguments are a JSON
        # string split across many chunks.
        partial: dict[int, dict[str, Any]] = {}
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
                    raise self._error(
                        response.status_code,
                        payload,
                        parse_retry_after(response.headers.get("retry-after")),
                    )

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if chunk.get("error"):
                        raise self._error(500, chunk)
                    raw_usage = chunk.get("usage") or (chunk.get("x_groq") or {}).get("usage")
                    if raw_usage:
                        usage = {
                            "input_tokens": int(raw_usage.get("prompt_tokens") or 0),
                            "output_tokens": int(raw_usage.get("completion_tokens") or 0),
                            "total_tokens": int(raw_usage.get("total_tokens") or 0),
                        }
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if content:
                        text_chunks.append(content)
                        yield TextDelta(content)
                    for fragment in delta.get("tool_calls") or []:
                        index = int(fragment.get("index") or 0)
                        entry = partial.setdefault(
                            index, {"id": "", "name": "", "arguments": "", "extra": {}}
                        )
                        if fragment.get("id"):
                            entry["id"] = fragment["id"]
                        function = fragment.get("function") or {}
                        if function.get("name"):
                            entry["name"] = function["name"]
                        if function.get("arguments"):
                            entry["arguments"] += function["arguments"]
                        # Keep unknown fields (Gemini's compat endpoint puts its
                        # thought signature in extra_content) to echo back later.
                        for key, value in fragment.items():
                            if key not in ("index", "id", "type", "function"):
                                entry["extra"][key] = value
        except httpx.TimeoutException as exc:
            raise LLMError(f"{self.label} took too long to respond.", kind="network") from exc
        except httpx.HTTPError as exc:
            raise LLMError(
                f"Couldn't reach {self.label}. Check the internet connection.", kind="network"
            ) from exc

        calls: list[ToolCall] = []
        raw_calls: list[dict[str, Any]] = []
        for index in sorted(partial):
            entry = partial[index]
            arguments = entry["arguments"].strip() or "{}"
            try:
                args = json.loads(arguments)
            except ValueError as exc:
                raise LLMError(
                    f"{self.label} produced a tool call it couldn't finish.", kind="server"
                ) from exc
            if not isinstance(args, dict):
                args = {}
            call_id = entry["id"] or f"call_{index + 1}"
            calls.append(ToolCall(id=call_id, name=entry["name"], args=args, native_id=call_id))
            raw_calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": entry["name"], "arguments": arguments},
                    **entry["extra"],
                }
            )

        text = "".join(text_chunks)
        raw: dict[str, Any] = {"role": "assistant", "content": text or None}
        if raw_calls:
            raw["tool_calls"] = raw_calls
        yield TurnEnd(
            ChatMessage(
                role="assistant",
                text=text,
                tool_calls=calls,
                raw=raw if (text or raw_calls) else None,
                raw_provider=self.name,
            ),
            usage,
        )

    async def list_models(self) -> list[str]:
        response = await self.client.get(f"{self.base_url}/models", headers=self._headers())
        if response.status_code != 200:
            try:
                payload = response.json()
            except ValueError:
                payload = None
            raise self._error(response.status_code, payload)
        return sorted(str(m.get("id", "")) for m in response.json().get("data") or [])
