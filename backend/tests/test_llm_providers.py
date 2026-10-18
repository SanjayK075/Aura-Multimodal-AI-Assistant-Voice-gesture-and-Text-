"""The LLM providers against recorded-style responses in each API's wire format.

These pin down the parts that are easy to get wrong without a live key:
stream parsing, the exact request body, echoing Gemini's thought signatures,
and turning HTTP failures into actionable messages.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.llm import FallbackProvider, build_provider
from app.llm.base import ChatMessage, LLMError, TextDelta, ToolCall, ToolOutput, ToolSpec, TurnEnd
from app.llm.demo import DemoProvider, route
from app.llm.gemini import SKIP_SIGNATURE, GeminiProvider, _merge_text_parts
from app.llm.openai_compat import OpenAICompatProvider

from .conftest import make_settings, sse_response

WEATHER = ToolSpec(
    "get_weather",
    "Weather for a city.",
    {"type": "object", "properties": {"city": {"type": "string"}}},
)
NO_ARGS = ToolSpec("get_iss_position", "Where the ISS is.", {"type": "object", "properties": {}})


async def collect(provider, messages, tools=(WEATHER,), system="sys"):
    deltas, end = [], None
    async for event in provider.stream(system, list(messages), list(tools)):
        if isinstance(event, TextDelta):
            deltas.append(event.text)
        elif isinstance(event, TurnEnd):
            end = event
    return "".join(deltas), end


def recorder(*responses):
    """A fake server that replays responses in order and records the requests."""
    queue, requests = list(responses), []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return queue.pop(0)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), requests


def body(request: httpx.Request) -> dict:
    return json.loads(request.content)


# ======================== Gemini ========================


def gemini(client, **kwargs):
    return GeminiProvider(api_key="KEY", model="gemini-test", client=client, **kwargs)


async def test_gemini_streams_text_and_builds_request():
    client, requests = recorder(
        sse_response(
            {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello"}]}}]},
            {"candidates": [{"content": {"role": "model", "parts": [{"text": " there"}]}, "finishReason": "STOP"}],
             "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 3, "totalTokenCount": 15}},
        )
    )
    text, end = await collect(gemini(client), [ChatMessage("user", "hi")], tools=(WEATHER, NO_ARGS))
    assert text == "Hello there" and end.message.text == "Hello there"
    assert end.usage == {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}
    assert end.message.raw == [{"text": "Hello there"}]  # chunks merged for the echo

    request = requests[0]
    assert str(request.url).endswith("/models/gemini-test:streamGenerateContent?alt=sse")
    assert request.headers["x-goog-api-key"] == "KEY"
    sent = body(request)
    assert sent["systemInstruction"] == {"parts": [{"text": "sys"}]}
    assert sent["contents"] == [{"role": "user", "parts": [{"text": "hi"}]}]
    declarations = sent["tools"][0]["functionDeclarations"]
    assert declarations[0]["parameters"]["properties"] == {"city": {"type": "string"}}
    assert "parameters" not in declarations[1]  # an empty object schema is rejected by Gemini
    assert "thinkingConfig" not in sent["generationConfig"]


async def test_gemini_tool_call_keeps_thought_signature_through_the_round_trip():
    call_part = {
        "functionCall": {"name": "get_weather", "args": {"city": "Chennai"}, "id": "fc_1"},
        "thoughtSignature": "c2lnbmF0dXJl",
    }
    client, requests = recorder(
        sse_response({"candidates": [{"content": {"role": "model", "parts": [call_part]}, "finishReason": "STOP"}]}),
        sse_response({"candidates": [{"content": {"role": "model", "parts": [{"text": "31 degrees."}]}, "finishReason": "STOP"}]}),
    )
    provider = gemini(client)
    history = [ChatMessage("user", "weather in chennai?")]
    _, end = await collect(provider, history)
    call = end.message.tool_calls[0]
    assert (call.name, call.args, call.id, call.native_id) == ("get_weather", {"city": "Chennai"}, "fc_1", "fc_1")

    history += [end.message, ChatMessage("tool", tool_outputs=[ToolOutput(call, {"temp": 31})])]
    text, _ = await collect(provider, history)
    assert text == "31 degrees."

    contents = body(requests[1])["contents"]
    assert contents[1] == {"role": "model", "parts": [call_part]}  # echoed byte for byte
    assert contents[2] == {
        "role": "user",
        "parts": [{"functionResponse": {"name": "get_weather", "response": {"temp": 31}, "id": "fc_1"}}],
    }


async def test_gemini_without_call_ids_generates_them_and_omits_response_id():
    client, requests = recorder(
        sse_response({"candidates": [{"content": {"parts": [
            {"functionCall": {"name": "get_weather", "args": {"city": "A"}}},
            {"functionCall": {"name": "get_weather", "args": {"city": "B"}}},
        ]}}]}),
        sse_response({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}),
    )
    provider = gemini(client)
    _, end = await collect(provider, [ChatMessage("user", "compare")])
    calls = end.message.tool_calls
    assert [c.id for c in calls] == ["call_1", "call_2"] and calls[0].native_id is None

    outputs = [ToolOutput(c, {"ok": True}) for c in calls]
    await collect(provider, [ChatMessage("user", "compare"), end.message, ChatMessage("tool", tool_outputs=outputs)])
    responses = body(requests[1])["contents"][2]["parts"]
    assert [p["functionResponse"]["name"] for p in responses] == ["get_weather", "get_weather"]
    assert all("id" not in p["functionResponse"] for p in responses)  # grouped, in order, no invented ids


async def test_gemini_replays_another_providers_tool_call_with_placeholder_signature():
    foreign = ChatMessage(
        "assistant",
        tool_calls=[ToolCall("call_x", "get_weather", {"city": "Pune"}, native_id="call_x")],
        raw={"role": "assistant", "tool_calls": []},
        raw_provider="groq",
    )
    client, requests = recorder(sse_response({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
    await collect(gemini(client), [ChatMessage("user", "q"), foreign])
    part = body(requests[0])["contents"][1]["parts"][0]
    assert part["thoughtSignature"] == SKIP_SIGNATURE
    assert part["functionCall"] == {"name": "get_weather", "args": {"city": "Pune"}, "id": "call_x"}


async def test_gemini_skips_thought_summaries_and_keeps_signature_parts():
    client, _ = recorder(
        sse_response(
            {"candidates": [{"content": {"parts": [{"text": "planning...", "thought": True}]}}]},
            {"candidates": [{"content": {"parts": [{"text": "Answer."}]}}]},
            {"candidates": [{"content": {"parts": [{"text": "", "thoughtSignature": "sig"}]}, "finishReason": "STOP"}]},
        )
    )
    text, end = await collect(gemini(client), [ChatMessage("user", "q")])
    assert text == "Answer."
    assert end.message.raw == [{"text": "Answer."}, {"text": "", "thoughtSignature": "sig"}]


def test_merge_text_parts():
    assert _merge_text_parts([{"text": "a"}, {"text": "b"}, {"functionCall": {}}, {"text": "c"}]) == [
        {"text": "ab"}, {"functionCall": {}}, {"text": "c"}
    ]
    assert _merge_text_parts([{"text": ""}]) == []


async def test_gemini_thinking_level_is_optional_config():
    client, requests = recorder(sse_response({"candidates": [{"content": {"parts": [{"text": "x"}]}}]}))
    await collect(gemini(client, thinking_level="low", max_output_tokens=500), [ChatMessage("user", "q")])
    assert body(requests[0])["generationConfig"] == {
        "maxOutputTokens": 500,
        "thinkingConfig": {"thinkingLevel": "LOW"},
    }


@pytest.mark.parametrize(
    "status, payload, kind, fragment",
    [
        (400, {"error": {"message": "API key not valid. Please pass a valid API key."}}, "auth", "GEMINI_API_KEY"),
        (403, {"error": {"message": "Permission denied"}}, "auth", "GEMINI_API_KEY"),
        (404, {"error": {"message": "models/x is not found"}}, "model", "GEMINI_MODEL"),
        (429, {"error": {"message": "quota", "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "23s"}]}}, "rate_limit", "24 seconds"),
        (503, {"error": {"message": "overloaded"}}, "server", "having trouble"),
        (400, {"error": {"message": "Invalid JSON payload"}}, "bad_request", "Invalid JSON payload"),
        (500, None, "server", "having trouble"),
    ],
)
async def test_gemini_http_errors(status, payload, kind, fragment):
    response = httpx.Response(status, json=payload) if payload is not None else httpx.Response(status, text="<html>")
    client, _ = recorder(response)
    with pytest.raises(LLMError) as info:
        await collect(gemini(client), [ChatMessage("user", "q")])
    assert info.value.kind == kind and fragment in info.value.message
    if kind == "rate_limit":
        assert info.value.retry_after == 23.0


@pytest.mark.parametrize(
    "chunk, kind",
    [
        ({"promptFeedback": {"blockReason": "SAFETY"}}, "blocked"),
        ({"candidates": [{"finishReason": "SAFETY"}]}, "blocked"),
        ({"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL"}]}, "server"),
        ({"candidates": [{"finishReason": "MAX_TOKENS"}]}, "bad_request"),
        ({"error": {"code": 429, "message": "quota"}}, "rate_limit"),
    ],
)
async def test_gemini_failures_inside_a_200_stream(chunk, kind):
    client, _ = recorder(sse_response(chunk))
    with pytest.raises(LLMError) as info:
        await collect(gemini(client), [ChatMessage("user", "q")])
    assert info.value.kind == kind


async def test_gemini_network_failures():
    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)

    def refused(request):
        raise httpx.ConnectError("no route", request=request)

    for handler, fragment in ((timeout, "too long"), (refused, "Couldn't reach")):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with pytest.raises(LLMError) as info:
            await collect(gemini(client), [ChatMessage("user", "q")])
        assert info.value.kind == "network" and fragment in info.value.message


async def test_gemini_list_models_filters_to_chat_models():
    client, _ = recorder(
        httpx.Response(200, json={"models": [
            {"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/embedding-1", "supportedGenerationMethods": ["embedContent"]},
        ]})
    )
    assert await gemini(client).list_models() == ["gemini-3.8-flash"]


# ======================== OpenAI-compatible (Groq) ========================


def groq(client, **kwargs):
    return OpenAICompatProvider(
        name="groq", base_url="https://api.groq.com/openai/v1", api_key="KEY",
        model="test-model", client=client, label="Groq", env_prefix="GROQ", **kwargs,
    )


def chunk(delta, **extra):
    return {"choices": [{"index": 0, "delta": delta}], **extra}


async def test_openai_streams_text_and_builds_request():
    client, requests = recorder(
        sse_response(
            chunk({"role": "assistant", "content": ""}),
            chunk({"reasoning": "thinking it over"}),  # reasoning models add this; ignored
            chunk({"content": "Hi"}),
            chunk({"content": " you"}),
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "x_groq": {"usage": {"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11}}},
            done=True,
        )
    )
    provider = groq(client, extra_body={"max_completion_tokens": 256})
    text, end = await collect(provider, [ChatMessage("user", "hi")], tools=(NO_ARGS,))
    assert text == "Hi you"
    assert end.usage == {"input_tokens": 9, "output_tokens": 2, "total_tokens": 11}

    request = requests[0]
    assert str(request.url) == "https://api.groq.com/openai/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer KEY"
    sent = body(request)
    assert sent["model"] == "test-model" and sent["stream"] is True
    assert sent["max_completion_tokens"] == 256
    assert sent["messages"] == [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}]
    assert sent["tools"][0]["function"]["parameters"] == {"type": "object", "properties": {}}


async def test_openai_assembles_fragmented_tool_calls_and_echoes_them():
    client, requests = recorder(
        sse_response(
            chunk({"tool_calls": [{"index": 0, "id": "call_a", "type": "function",
                                   "function": {"name": "get_weather", "arguments": ""},
                                   "extra_content": {"google": {"thought_signature": "sig"}}}]}),
            chunk({"tool_calls": [{"index": 0, "function": {"arguments": '{"city": "Che'}}]}),
            chunk({"tool_calls": [{"index": 0, "function": {"arguments": 'nnai"}'}}]}),
            chunk({"tool_calls": [{"index": 1, "id": "call_b", "function": {"name": "get_weather", "arguments": '{"city":"Pune"}'}}]}),
            done=True,
        ),
        sse_response(chunk({"content": "Done."}), done=True),
    )
    provider = groq(client)
    history = [ChatMessage("user", "compare")]
    _, end = await collect(provider, history)
    calls = end.message.tool_calls
    assert [(c.id, c.args) for c in calls] == [("call_a", {"city": "Chennai"}), ("call_b", {"city": "Pune"})]

    history += [end.message, ChatMessage("tool", tool_outputs=[ToolOutput(c, {"t": 30}) for c in calls])]
    await collect(provider, history)
    messages = body(requests[1])["messages"]
    assistant = messages[2]
    assert assistant["content"] is None
    assert assistant["tool_calls"][0] == {
        "id": "call_a", "type": "function",
        "function": {"name": "get_weather", "arguments": '{"city": "Chennai"}'},
        "extra_content": {"google": {"thought_signature": "sig"}},  # unknown fields survive
    }
    assert messages[3] == {"role": "tool", "tool_call_id": "call_a", "name": "get_weather", "content": '{"t": 30}'}
    assert messages[4]["tool_call_id"] == "call_b"


async def test_openai_rebuilds_history_written_by_another_provider():
    foreign = ChatMessage(
        "assistant", text="", tool_calls=[ToolCall("call_1", "get_weather", {"city": "Goa"})],
        raw=[{"functionCall": {}}], raw_provider="gemini",
    )
    client, requests = recorder(sse_response(chunk({"content": "ok"}), done=True))
    await collect(groq(client), [ChatMessage("user", "q"), foreign, ChatMessage("assistant", text="")])
    messages = body(requests[0])["messages"]
    assert len(messages) == 3  # the empty assistant message is dropped
    assert messages[2]["tool_calls"][0]["function"] == {"name": "get_weather", "arguments": '{"city": "Goa"}'}


async def test_openai_no_auth_header_without_key():
    client, requests = recorder(sse_response(chunk({"content": "ok"}), done=True))
    provider = OpenAICompatProvider(name="openai_compat", base_url="http://localhost:11434/v1/", api_key="", model="llama", client=client)
    await collect(provider, [ChatMessage("user", "q")], tools=())
    assert "authorization" not in requests[0].headers
    assert str(requests[0].url) == "http://localhost:11434/v1/chat/completions"
    assert "tools" not in body(requests[0])


@pytest.mark.parametrize(
    "status, payload, headers, kind, fragment",
    [
        (401, {"error": {"message": "Invalid API Key", "code": "invalid_api_key"}}, {}, "auth", "GROQ_API_KEY"),
        (404, {"error": {"message": "The model `x` does not exist", "code": "model_not_found"}}, {}, "model", "GROQ_MODEL"),
        (400, {"error": {"message": "The model `x` has been decommissioned", "code": "model_decommissioned"}}, {}, "model", "GROQ_MODEL"),
        (429, {"error": {"message": "Rate limit reached"}}, {"retry-after": "7"}, "rate_limit", "8 seconds"),
        (400, {"error": {"message": "Failed to call a function", "code": "tool_use_failed"}}, {}, "server", "couldn't finish"),
        (400, {"error": {"message": "messages is required"}}, {}, "bad_request", "messages is required"),
        (502, None, {}, "server", "having trouble"),
    ],
)
async def test_openai_http_errors(status, payload, headers, kind, fragment):
    response = httpx.Response(status, json=payload, headers=headers) if payload else httpx.Response(status, text="bad gateway")
    client, _ = recorder(response)
    with pytest.raises(LLMError) as info:
        await collect(groq(client), [ChatMessage("user", "q")])
    assert info.value.kind == kind and fragment in info.value.message


async def test_openai_unparseable_tool_arguments_are_retryable():
    client, _ = recorder(
        sse_response(chunk({"tool_calls": [{"index": 0, "id": "c", "function": {"name": "get_weather", "arguments": '{"city": '}}]}), done=True)
    )
    with pytest.raises(LLMError) as info:
        await collect(groq(client), [ChatMessage("user", "q")])
    assert info.value.retryable


async def test_openai_error_inside_stream():
    client, _ = recorder(sse_response({"error": {"message": "upstream reset"}}))
    with pytest.raises(LLMError) as info:
        await collect(groq(client), [ChatMessage("user", "q")])
    assert info.value.kind == "server"


# ======================== Demo router ========================


@pytest.mark.parametrize(
    "question, expected",
    [
        ("What's the weather in Chennai this weekend?", ("get_weather", {"city": "Chennai", "days": 7})),
        ("will it rain tomorrow", ("get_weather", {})),
        ("weather in New York right now", ("get_weather", {"city": "New York"})),
        ("where is the ISS", ("get_iss_position", {})),
        ("show issues on fastapi/fastapi", ("github_repo_issues", {"repo": "fastapi/fastapi"})),
        ("show my github repos", ("github_user_repos", {})),
        ("repos by torvalds sorted by stars", ("github_user_repos", {"username": "torvalds", "sort": "stars"})),
        ("latest news about artificial intelligence", ("get_news", {"topic": "artificial intelligence"})),
        ("top headlines", ("get_news", {})),
        ("upcoming rocket launches", ("get_upcoming_launches", {})),
        ("show NASA's picture of the day", ("get_space_picture", {})),
        ("Who was Alan Turing?", ("wikipedia_summary", {"query": "Alan Turing"})),
        ("what is a black hole", ("wikipedia_summary", {"query": "black hole"})),
        ("what time is it", ("get_datetime", {})),
        ("write me a poem", None),
    ],
)
def test_demo_router(question, expected):
    assert route(question, {}) == expected


async def test_demo_provider_calls_tool_then_reads_summary():
    provider = DemoProvider(word_delay=0)
    text, end = await collect(provider, [ChatMessage("user", "weather in Pune")])
    assert text == "" and end.message.tool_calls[0].name == "get_weather"

    call = end.message.tool_calls[0]
    history = [ChatMessage("user", "weather in Pune"), end.message,
               ChatMessage("tool", tool_outputs=[ToolOutput(call, {"summary": "Pune: 27 degrees."})])]
    text, end = await collect(provider, history)
    assert text == "Pune: 27 degrees." and not end.message.tool_calls

    failed = [*history[:2], ChatMessage("tool", tool_outputs=[ToolOutput(call, {"error": "No such city."})])]
    text, _ = await collect(provider, failed)
    assert text == "That didn't work: No such city."

    text, _ = await collect(provider, [ChatMessage("user", "explain recursion")])
    assert "demo mode" in text
    # A tool the caller didn't offer is never called.
    text, end = await collect(provider, [ChatMessage("user", "weather in Pune")], tools=())
    assert not end.message.tool_calls and "demo mode" in text


# ======================== Choosing and falling back ========================


class Scripted:
    """A provider that plays back a script: strings are streamed, exceptions raised."""

    def __init__(self, name, *script):
        self.name, self.model, self.script, self.calls = name, f"{name}-model", list(script), 0

    async def stream(self, system, messages, tools, context=None):
        self.calls += 1
        step = self.script.pop(0)
        if isinstance(step, tuple):  # (text streamed before failing, error)
            yield TextDelta(step[0])
            raise step[1]
        if isinstance(step, Exception):
            raise step
        yield TextDelta(step)
        yield TurnEnd(ChatMessage("assistant", text=step, raw_provider=self.name))


async def test_fallback_moves_on_when_first_provider_is_rate_limited():
    first = Scripted("gemini", LLMError("quota", kind="rate_limit"))
    second = Scripted("groq", "from groq")
    provider = FallbackProvider([first, second])
    assert provider.name == "gemini"
    text, end = await collect(provider, [ChatMessage("user", "q")])
    assert text == "from groq" and end.message.raw_provider == "groq"
    assert (provider.name, provider.model) == ("groq", "groq-model")  # reports who actually answered


@pytest.mark.parametrize("kind", ["blocked", "bad_request"])
async def test_fallback_does_not_retry_requests_that_would_fail_anywhere(kind):
    second = Scripted("groq", "never used")
    provider = FallbackProvider([Scripted("gemini", LLMError("no", kind=kind)), second])
    with pytest.raises(LLMError):
        await collect(provider, [ChatMessage("user", "q")])
    assert second.calls == 0


async def test_fallback_never_switches_mid_answer():
    second = Scripted("groq", "never used")
    provider = FallbackProvider([Scripted("gemini", ("Half an ans", LLMError("dropped", kind="network"))), second])
    with pytest.raises(LLMError):
        await collect(provider, [ChatMessage("user", "q")])
    assert second.calls == 0


async def test_fallback_rests_a_failed_provider_then_tries_it_again():
    now = [0.0]
    first = Scripted("gemini", LLMError("quota", kind="rate_limit", retry_after=20), "gemini is back")
    second = Scripted("groq", "groq 1", "groq 2")
    provider = FallbackProvider([first, second], clock=lambda: now[0])

    assert (await collect(provider, [ChatMessage("user", "q")]))[0] == "groq 1"
    now[0] = 10  # still resting: Gemini is not even asked
    assert (await collect(provider, [ChatMessage("user", "q")]))[0] == "groq 2"
    assert (first.calls, second.calls) == (1, 2)
    now[0] = 21  # rest over: back to the preferred provider
    assert (await collect(provider, [ChatMessage("user", "q")]))[0] == "gemini is back"
    assert provider.name == "gemini"


async def test_fallback_still_uses_a_resting_provider_when_nothing_else_works():
    now = [0.0]
    first = Scripted("gemini", LLMError("quota", kind="rate_limit"), "recovered")
    second = Scripted("groq", "ok", LLMError("down", kind="server"))
    provider = FallbackProvider([first, second], clock=lambda: now[0])
    await collect(provider, [ChatMessage("user", "q")])  # gemini fails, groq answers
    # Next request: gemini is resting so groq goes first, fails, and gemini is the last resort.
    assert (await collect(provider, [ChatMessage("user", "q")]))[0] == "recovered"


async def test_fallback_raises_the_last_error_when_all_fail():
    provider = FallbackProvider([
        Scripted("gemini", LLMError("first", kind="rate_limit")),
        Scripted("groq", LLMError("second", kind="server")),
    ])
    with pytest.raises(LLMError, match="second"):
        await collect(provider, [ChatMessage("user", "q")])


def test_build_provider_choices():
    client = httpx.AsyncClient()
    assert build_provider(make_settings(llm_provider="auto"), client).name == "demo"
    assert build_provider(make_settings(llm_provider="auto", gemini_api_key="g"), client).name == "gemini"
    only_groq = build_provider(make_settings(llm_provider="auto", groq_api_key="q"), client)
    assert (only_groq.name, only_groq.model) == ("groq", "openai/gpt-oss-120b")
    both = build_provider(make_settings(llm_provider="auto", gemini_api_key="g", groq_api_key="q"), client)
    assert isinstance(both, FallbackProvider) and [p.name for p in both.providers] == ["gemini", "groq"]
    assert build_provider(make_settings(llm_provider="groq", gemini_api_key="g", groq_api_key="q"), client).name == "groq"
    assert build_provider(make_settings(llm_provider="demo", gemini_api_key="g"), client).name == "demo"

    for bad in (dict(llm_provider="gemini"), dict(llm_provider="groq"), dict(llm_provider="openai_compat"), dict(llm_provider="claude")):
        with pytest.raises(ValueError):
            build_provider(make_settings(**bad), client)


def test_groq_request_carries_configured_limits():
    client = httpx.AsyncClient()
    provider = build_provider(
        make_settings(llm_provider="groq", groq_api_key="q", groq_reasoning_effort="LOW", llm_max_output_tokens=777), client
    )
    sent = provider.build_body("s", [ChatMessage("user", "q")], [])
    assert sent["max_completion_tokens"] == 777 and sent["reasoning_effort"] == "low"
