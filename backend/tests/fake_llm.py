"""A stand-in LLM server that speaks both wire formats the app uses.

It serves Gemini's streamGenerateContent and the OpenAI/Groq chat-completions
endpoint over real HTTP, with realistic chunked streaming. The integration
tests point the real providers at it, which exercises everything a unit test
with a fake transport cannot: actual sockets, chunk boundaries and timing.

It is also a way to develop the frontend without spending API quota:

    uvicorn tests.fake_llm:app --port 9000
    # then in backend/.env:
    #   LLM_PROVIDER=gemini
    #   GEMINI_API_KEY=anything
    #   GEMINI_BASE_URL=http://localhost:9000/v1beta

Behaviour is scripted from the user's words (it reuses the demo router to pick
tools). A few magic phrases trigger the awkward cases:

    "chain"     two tool calls in sequence (repositories, then issues)
    "both"      two tool calls in one step (Gemini only; like real parallel calls)
    "preamble"  text before a tool call, which the app must discard
    "flaky"     one 429 with a short retry delay, then success
    "quota"     a 429 asking to wait a minute, which the app should report
    "gemini is full"  the same, but only from the Gemini endpoint (to test falling back)
    "badkey"    an authentication error
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.llm.demo import route

app = FastAPI(title="Fake LLM")
SIGNATURE = "ZmFrZS10aG91Z2h0LXNpZ25hdHVyZQ=="
state: dict[str, Any] = {"flaky_seen": 0, "requests": []}

ESSAY = (
    "A hash map stores **key-value pairs** and finds a value from its key in constant time on average.\n\n"
    "It works in three steps:\n"
    "1. A *hash function* turns the key into a number.\n"
    "2. That number, modulo the table size, picks a bucket.\n"
    "3. The bucket holds the entry, with a short list or probing to handle collisions.\n\n"
    "```python\nages = {}\nages[\"asha\"] = 21   # insert\nprint(ages[\"asha\"])  # lookup\n```\n"
    "Lookups slow down only when many keys land in one bucket, so tables grow as they fill."
)


def pieces(text: str, size: int = 9) -> list[str]:
    """Cut text at awkward places, the way real token streams do."""
    return [text[i : i + size] for i in range(0, len(text), size)]


def plan(question: str, tool_results: list[dict[str, Any]], steps_done: int) -> dict[str, Any]:
    """Decide what the 'model' does next: {"text": ...} and/or {"calls": [(name, args), ...]}."""
    lowered = question.lower()
    if "chain" in lowered:
        if steps_done == 0:
            return {"calls": [("github_user_repos", {"username": "octocat"})]}
        if steps_done == 1:
            return {"calls": [("github_repo_issues", {"repo": "octocat/aura-assistant"})]}
        return {"text": "octocat's most recent repository is aura-assistant, and it has four open issues."}
    if "both" in lowered and steps_done == 0:
        return {"calls": [("get_weather", {"city": "Chennai"}), ("get_weather", {"city": "Mumbai"})]}
    if "preamble" in lowered and steps_done == 0:
        return {"text": "Let me look that up.", "calls": [("get_datetime", {})]}
    if tool_results:
        failed = [r["error"] for r in tool_results if r.get("error")]
        if failed:
            return {"text": f"That didn't work: {failed[0]}"}
        return {"text": " ".join(str(r.get("summary", "Done.")) for r in tool_results)}
    choice = route(question, {})
    if choice and steps_done == 0:
        return {"calls": [choice]}
    return {"text": ESSAY}


def special_error(question: str, endpoint: str) -> tuple[int, str, float | None] | None:
    lowered = question.lower()
    if "badkey" in lowered:
        return 401, "Invalid API key", None
    if "quota" in lowered or ("gemini is full" in lowered and endpoint == "gemini"):
        return 429, "Quota exceeded", 60.0
    if "flaky" in lowered:
        state["flaky_seen"] += 1
        if state["flaky_seen"] == 1:  # only the first request fails; reset the counter to repeat
            return 429, "Slow down", 1.0
    return None


# ---- Gemini ---------------------------------------------------------------------


@app.post("/v1beta/models/{model}:streamGenerateContent")
async def gemini(model: str, request: Request):
    body = await request.json()
    state["requests"].append(("gemini", body))
    if not request.headers.get("x-goog-api-key"):
        return JSONResponse({"error": {"code": 400, "message": "API key not valid."}}, status_code=400)
    if model == "retired-model":
        return JSONResponse({"error": {"code": 404, "message": f"models/{model} is not found"}}, status_code=404)

    contents = body.get("contents") or []
    question = ""
    last_user_index = 0
    for index, content in enumerate(contents):
        texts = [p["text"] for p in content.get("parts", []) if "text" in p]
        if content.get("role") == "user" and texts:
            question, last_user_index = texts[-1], index
    turn = contents[last_user_index + 1 :]

    # Like the real API: every step's first function call must come back with its signature.
    for content in turn:
        calls = [p for p in content.get("parts", []) if "functionCall" in p]
        # ...or with the documented placeholder, for calls another model produced.
        accepted = (SIGNATURE, "skip_thought_signature_validator")
        if content.get("role") == "model" and calls and calls[0].get("thoughtSignature") not in accepted:
            return JSONResponse(
                {"error": {"code": 400, "message": "Function call is missing a thought_signature in functionCall parts."}},
                status_code=400,
            )

    error = special_error(question, "gemini")
    if error:
        status, message, delay = error
        details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": f"{delay:g}s"}] if delay else []
        return JSONResponse({"error": {"code": status, "message": message, "details": details}}, status_code=status)

    results = [
        p["functionResponse"]["response"]
        for content in turn[-1:]
        for p in content.get("parts", [])
        if "functionResponse" in p
    ]
    steps_done = sum(1 for content in turn if content.get("role") == "model")
    step = plan(question, results, steps_done)

    async def stream() -> AsyncIterator[bytes]:
        def event(parts: list[dict[str, Any]], finish: str | None = None) -> bytes:
            candidate: dict[str, Any] = {"content": {"role": "model", "parts": parts}, "index": 0}
            if finish:
                candidate["finishReason"] = finish
            payload: dict[str, Any] = {"candidates": [candidate]}
            if finish:
                payload["usageMetadata"] = {"promptTokenCount": 120, "candidatesTokenCount": 40, "totalTokenCount": 160}
            return f"data: {json.dumps(payload)}\r\n\r\n".encode()

        for chunk in pieces(step.get("text", "")):
            yield event([{"text": chunk}])
            await asyncio.sleep(0.01)
        calls = step.get("calls") or []
        parts = []
        for index, (name, args) in enumerate(calls):
            part: dict[str, Any] = {"functionCall": {"name": name, "args": args, "id": f"fc_{steps_done}_{index}"}}
            if index == 0:
                part["thoughtSignature"] = SIGNATURE
            parts.append(part)
        yield event(parts or [{"text": ""}], finish="STOP")

    return StreamingResponse(stream(), media_type="text/event-stream")


# ---- OpenAI-compatible (Groq) -----------------------------------------------------


@app.post("/openai/v1/chat/completions")
async def openai(request: Request):
    body = await request.json()
    state["requests"].append(("openai", body))
    if not request.headers.get("authorization", "").startswith("Bearer "):
        return JSONResponse({"error": {"message": "Invalid API Key", "code": "invalid_api_key"}}, status_code=401)
    if body.get("model") == "retired-model":
        return JSONResponse(
            {"error": {"message": "The model `retired-model` has been decommissioned.", "code": "model_decommissioned"}},
            status_code=400,
        )

    messages = body.get("messages") or []
    last_user_index = max(i for i, m in enumerate(messages) if m.get("role") == "user")
    question = messages[last_user_index].get("content") or ""
    turn = messages[last_user_index + 1 :]

    error = special_error(question, "openai")
    if error:
        status, message, delay = error
        headers = {"retry-after": f"{delay:g}"} if delay else {}
        return JSONResponse({"error": {"message": message}}, status_code=status, headers=headers)

    results = []
    for message in reversed(turn):
        if message.get("role") != "tool":
            break
        results.insert(0, json.loads(message["content"]))
    steps_done = sum(1 for m in turn if m.get("role") == "assistant")
    step = plan(question, results, steps_done)

    async def stream() -> AsyncIterator[bytes]:
        def event(delta: dict[str, Any], finish: str | None = None) -> bytes:
            payload = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            return f"data: {json.dumps(payload)}\n\n".encode()

        yield event({"role": "assistant", "content": ""})
        for chunk in pieces(step.get("text", "")):
            yield event({"content": chunk})
            await asyncio.sleep(0.01)
        # This endpoint emulates a model without parallel tool calls: one call per step.
        for index, (name, args) in enumerate((step.get("calls") or [])[:1]):
            arguments = json.dumps(args)
            yield event({"tool_calls": [{"index": index, "id": f"call_{steps_done}_{index}", "type": "function", "function": {"name": name, "arguments": ""}}]})
            for fragment in pieces(arguments, 5):  # arguments arrive in fragments
                yield event({"tool_calls": [{"index": index, "function": {"arguments": fragment}}]})
        yield event({}, finish="tool_calls" if step.get("calls") else "stop")
        yield b'data: {"id":"chatcmpl-fake","choices":[],"x_groq":{"usage":{"prompt_tokens":120,"completion_tokens":40,"total_tokens":160}}}\n\n'
        yield b"data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/v1beta/models")
async def gemini_models():
    return {"models": [{"name": "models/fake-flash", "supportedGenerationMethods": ["generateContent"]}]}


@app.get("/openai/v1/models")
async def openai_models():
    return {"data": [{"id": "fake-oss-120b"}]}
