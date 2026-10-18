"""The real providers and the real agent loop against a real HTTP server.

tests/fake_llm.py plays the part of Gemini and Groq on a local port. Nothing
here uses a fake transport for the model: bytes travel over actual sockets and
are chunked the way the live APIs chunk them.
"""
from __future__ import annotations

import socket
import threading
import time

import httpx
import pytest
import uvicorn

from app.agent import run_agent
from app.llm import FallbackProvider, build_provider
from app.llm.base import LLMError

from . import fake_llm
from .conftest import make_ctx, make_settings


@pytest.fixture(scope="module")
def llm_server():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(fake_llm.app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("fake LLM server did not start")
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


def provider_for(kind: str, base: str, client: httpx.AsyncClient, **overrides):
    if kind == "gemini":
        values = dict(
            llm_provider="gemini", gemini_api_key="test-key", gemini_model="fake-flash",
            gemini_base_url=f"{base}/v1beta",
        )
    else:
        values = dict(
            llm_provider="openai_compat", openai_compat_api_key="test-key", openai_compat_model="fake-oss-120b",
            openai_compat_base_url=f"{base}/openai/v1",
        )
    return build_provider(make_settings(**{**values, **overrides}), client)


async def converse(provider, question, **kwargs):
    events = []
    slept = []

    async def sleep(seconds):
        slept.append(seconds)

    async for event in run_agent(
        provider=provider, system="You are a test.", history=[], user_text=question,
        ctx=make_ctx(default_city="Chennai"), sleep=sleep, **kwargs,
    ):
        events.append(event)
    return events, slept


BOTH = pytest.mark.parametrize("kind", ["gemini", "openai"])


@BOTH
async def test_general_question_streams_in_many_pieces(kind, llm_server):
    async with httpx.AsyncClient(timeout=10) as client:
        events, _ = await converse(provider_for(kind, llm_server, client), "explain how a hash map works")
    deltas = [e.data["text"] for e in events if e.type == "delta"]
    assert len(deltas) > 20  # arrived incrementally, not as one blob
    assert "".join(deltas) == fake_llm.ESSAY
    done = events[-1].data
    assert done["text"] == fake_llm.ESSAY and done["steps"] == 1 and done["tools"] == []
    assert done["usage"]["total_tokens"] == 160


@BOTH
async def test_tool_round_trip_over_the_wire(kind, llm_server):
    async with httpx.AsyncClient(timeout=10) as client:
        events, _ = await converse(provider_for(kind, llm_server, client), "What's the weather in Tokyo?")
    tool = next(e.data for e in events if e.type == "tool")
    assert tool["ok"] and tool["args"]["city"] == "Tokyo" and tool["panel"]["type"] == "weather"
    done = events[-1].data
    # The fake model repeats the tool's summary, proving the result reached it intact.
    assert done["text"] == tool["summary"] and done["steps"] == 2


@BOTH
async def test_two_tools_in_sequence(kind, llm_server):
    async with httpx.AsyncClient(timeout=10) as client:
        events, _ = await converse(provider_for(kind, llm_server, client), "chain: octocat's repos then issues")
    tools = [e.data for e in events if e.type == "tool"]
    assert [t["name"] for t in tools] == ["github_user_repos", "github_repo_issues"]
    assert tools[1]["args"]["repo"] == "octocat/aura-assistant"
    assert events[-1].data["steps"] == 3 and "four open issues" in events[-1].data["text"]


async def test_gemini_parallel_calls_and_signature_echo(llm_server):
    """The fake server, like Gemini 3, rejects a follow-up whose first function
    call lost its thought signature. A pass here means the echo is byte-exact."""
    async with httpx.AsyncClient(timeout=10) as client:
        events, _ = await converse(provider_for("gemini", llm_server, client), "compare both cities")
    tools = [e.data for e in events if e.type == "tool"]
    assert [t["args"]["city"] for t in tools] == ["Chennai", "Mumbai"]
    assert events[-1].type == "done" and "Chennai" in events[-1].data["text"] and "Mumbai" in events[-1].data["text"]

    follow_up = [body for kind, body in fake_llm.state["requests"] if kind == "gemini"][-1]
    model_turn, results = follow_up["contents"][-2], follow_up["contents"][-1]
    assert model_turn["parts"][0]["thoughtSignature"] == fake_llm.SIGNATURE
    assert "thoughtSignature" not in model_turn["parts"][1]
    assert [p["functionResponse"]["id"] for p in results["parts"]] == ["fc_0_0", "fc_0_1"]


@BOTH
async def test_text_before_a_tool_call_is_reset(kind, llm_server):
    async with httpx.AsyncClient(timeout=10) as client:
        events, _ = await converse(provider_for(kind, llm_server, client), "preamble please")
    order = [e.type for e in events]
    assert order.index("reset") < order.index("tool")
    assert events[-1].data["text"].startswith("It's ")


@BOTH
async def test_short_rate_limit_is_retried_transparently(kind, llm_server):
    fake_llm.state["flaky_seen"] = 0
    async with httpx.AsyncClient(timeout=10) as client:
        events, slept = await converse(provider_for(kind, llm_server, client), "flaky: what time is it")
    assert slept == [1.0]  # waited exactly as long as the server asked
    assert events[-1].type == "done" and events[-1].data["text"].startswith("It's ")


@BOTH
async def test_long_rate_limit_and_bad_key_surface_clear_errors(kind, llm_server):
    async with httpx.AsyncClient(timeout=10) as client:
        provider = provider_for(kind, llm_server, client)
        with pytest.raises(LLMError) as quota:
            await converse(provider, "quota test")
        assert quota.value.kind == "rate_limit" and quota.value.retry_after == 60.0
        assert "61 seconds" in quota.value.message
        with pytest.raises(LLMError) as key:
            await converse(provider, "badkey test")
        assert key.value.kind == "auth" and "API_KEY" in key.value.message


@BOTH
async def test_retired_model_is_reported_with_the_setting_to_change(kind, llm_server):
    async with httpx.AsyncClient(timeout=10) as client:
        overrides = {"gemini_model": "retired-model"} if kind == "gemini" else {"openai_compat_model": "retired-model"}
        provider = provider_for(kind, llm_server, client, **overrides)
        with pytest.raises(LLMError) as info:
            await converse(provider, "hello")
        assert info.value.kind == "model" and "_MODEL" in info.value.message
        assert await provider.list_models() in (["fake-flash"], ["fake-oss-120b"])


async def test_unreachable_server_is_a_network_error():
    async with httpx.AsyncClient(timeout=2) as client:
        provider = provider_for("gemini", "http://127.0.0.1:9", client)
        with pytest.raises(LLMError) as info:
            await converse(provider, "hello")
    assert info.value.kind == "network"


async def test_fallback_switches_provider_mid_conversation(llm_server):
    """Gemini is out of quota on the first step, so the other provider takes over
    and must make sense of nothing but the neutral message history."""
    async with httpx.AsyncClient(timeout=10) as client:
        gemini = provider_for("gemini", llm_server, client)
        other = provider_for("openai", llm_server, client)
        events, slept = await converse(FallbackProvider([gemini, other]), "gemini is full. weather in Paris")
    assert slept == []  # no waiting: it moved straight to the second provider
    done = events[-1].data
    assert done["provider"] == "openai_compat"
    assert [t["name"] for t in done["tools"]] == ["get_weather"] and done["text"].startswith("Paris, France")
    # Gemini was asked once, failed, and was then left alone for the rest of the answer.
    asked = [kind for kind, body in fake_llm.state["requests"] if "gemini is full" in str(body)]
    assert asked == ["gemini", "openai", "openai"]


async def test_gemini_accepts_a_tool_call_made_by_another_provider(llm_server):
    """If the conversation moves to Gemini after another model made a tool call,
    the replayed call carries the placeholder signature Gemini documents for this."""
    from app.llm.base import ChatMessage, TextDelta, ToolCall, ToolOutput
    from app.tools import specs

    call = ToolCall("call_0_0", "get_weather", {"city": "Pune"}, native_id="call_0_0")
    history = [
        ChatMessage("user", "weather in Pune?"),
        ChatMessage("assistant", tool_calls=[call], raw={"role": "assistant"}, raw_provider="groq"),
        ChatMessage("tool", tool_outputs=[ToolOutput(call, {"summary": "Pune: 27 degrees."})]),
    ]
    async with httpx.AsyncClient(timeout=10) as client:
        provider = provider_for("gemini", llm_server, client)
        text = ""
        async for event in provider.stream("sys", history, specs()):
            if isinstance(event, TextDelta):
                text += event.text
    assert text == "Pune: 27 degrees."
