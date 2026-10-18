"""The agent loop, driven by a scripted fake model so every branch is reachable."""
from __future__ import annotations

from typing import Any

import pytest

from app.agent import run_agent
from app.agent.followups import suggest
from app.agent.prompts import build_system_prompt
from app.llm.base import ChatMessage, LLMError, TextDelta, ToolCall, TurnEnd
from app.tools.base import ToolError, ToolResult, UserPrefs

from .conftest import make_ctx
from app import tools as tool_registry


class FakeModel:
    """Plays back one scripted turn per call and records what it was sent.

    A turn is a dict: {"text": str, "calls": [(name, args)], "error": LLMError,
    "error_after_text": bool}
    """

    name, model = "fake", "fake-1"

    def __init__(self, *turns: dict[str, Any]) -> None:
        self.turns = list(turns)
        self.seen: list[dict[str, Any]] = []

    async def stream(self, system, messages, tools, context=None):
        self.seen.append({"messages": list(messages), "tools": [t.name for t in tools], "system": system})
        turn = self.turns.pop(0)
        text = turn.get("text", "")
        if turn.get("error") and not turn.get("error_after_text"):
            raise turn["error"]
        for word in text.split(" ") if text else []:
            yield TextDelta(word + " ")
        if turn.get("error"):
            raise turn["error"]
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(turn.get("calls", []))]
        yield TurnEnd(ChatMessage("assistant", text=text, tool_calls=calls), {"total_tokens": 10})


async def run(model, question="hi", runner=None, **kwargs):
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    events = []
    arguments: dict[str, Any] = dict(
        provider=model, system="sys", history=[], user_text=question,
        ctx=make_ctx(default_city="Chennai"), sleep=sleep,
    )
    if runner:
        arguments["runner"] = runner
    arguments.update(kwargs)
    async for event in run_agent(**arguments):
        events.append(event)
    return events, slept


def types(events):
    return [e.type for e in events]


def done(events):
    assert events[-1].type == "done"
    return events[-1].data


async def test_plain_answer_streams_and_finishes():
    model = FakeModel({"text": "Recursion is a function calling itself."})
    events, _ = await run(model)
    assert types(events)[:2] == ["status", "status"]
    assert [e.data["state"] for e in events[:2]] == ["thinking", "answering"]
    assert "".join(e.data["text"] for e in events if e.type == "delta").strip() == done(events)["text"]
    result = done(events)
    assert result["steps"] == 1 and result["tools"] == []
    assert result["provider"] == "fake" and result["usage"]["total_tokens"] == 10
    assert result["followups"] == ["Explain that more simply", "Give me an example"]


async def test_tool_call_then_answer_uses_real_tool_and_feeds_result_back():
    model = FakeModel(
        {"calls": [("get_weather", {"city": "Tokyo"})]},
        {"text": "It's warm in Tokyo."},
    )
    events, _ = await run(model, "weather in tokyo?")
    assert types(events) == ["status", "status", "tool", "status", "status", "delta", "delta", "delta", "delta", "done"]
    assert events[1].data == {"state": "tool", "tool": "get_weather", "label": "Checking the weather"}

    tool = next(e.data for e in events if e.type == "tool")
    assert tool["ok"] and tool["panel"]["type"] == "weather"
    assert tool["args"]["city"] == "Tokyo" and tool["source"].startswith("Open-Meteo")
    assert "output" not in tool  # the model-facing payload isn't sent to the browser twice

    # The second model call saw the tool result.
    sent = model.seen[1]["messages"]
    assert [m.role for m in sent] == ["user", "assistant", "tool"]
    assert sent[2].tool_outputs[0].content["location"] == "Tokyo, Japan"

    result = done(events)
    assert result["steps"] == 2 and result["text"] == "It's warm in Tokyo."
    assert result["tools"][0]["name"] == "get_weather"
    assert "7-day forecast for Tokyo" in result["followups"]


async def test_tool_failure_is_reported_to_the_model_not_raised():
    model = FakeModel(
        {"calls": [("get_weather", {"city": "Atlantis"})]},
        {"text": "I couldn't find Atlantis."},
    )
    events, _ = await run(model)
    tool = next(e.data for e in events if e.type == "tool")
    assert not tool["ok"] and "Atlantis" in tool["error"] and tool["panel"] is None
    assert model.seen[1]["messages"][2].tool_outputs[0].content == {
        "error": "Couldn't find a place called 'Atlantis'."
    }
    assert done(events)["text"] == "I couldn't find Atlantis."


async def test_unknown_tool_name_from_model_is_survivable():
    model = FakeModel({"calls": [("teleport", {})]}, {"text": "I can't do that."})
    events, _ = await run(model)
    tool = next(e.data for e in events if e.type == "tool")
    assert not tool["ok"] and "no tool called 'teleport'" in tool["error"]


async def test_parallel_tool_calls_keep_their_order():
    model = FakeModel(
        {"calls": [("get_weather", {"city": "Tokyo"}), ("get_datetime", {}), ("get_weather", {"city": "Paris"})]},
        {"text": "Compared."},
    )
    events, _ = await run(model)
    tools = [e.data for e in events if e.type == "tool"]
    assert [t["name"] for t in tools] == ["get_weather", "get_datetime", "get_weather"]
    outputs = model.seen[1]["messages"][2].tool_outputs
    assert [o.call.id for o in outputs] == ["c0", "c1", "c2"]
    assert outputs[2].content["location"] == "Paris, France"


async def test_text_before_a_tool_call_is_discarded():
    model = FakeModel(
        {"text": "Let me check.", "calls": [("get_datetime", {})]},
        {"text": "Over the Pacific."},
    )
    events, _ = await run(model)
    order = types(events)
    assert order.index("reset") < order.index("tool")
    assert done(events)["text"] == "Over the Pacific."


async def test_step_limit_forces_an_answer_without_tools():
    model = FakeModel(
        {"calls": [("get_datetime", {})]},
        {"calls": [("get_datetime", {})]},
        {"text": "Here is what I found."},
    )
    events, _ = await run(model, max_steps=2)
    assert [bool(call["tools"]) for call in model.seen] == [True, True, False]
    assert done(events)["text"] == "Here is what I found." and done(events)["steps"] == 3


async def test_empty_final_reply_falls_back_to_tool_summaries():
    model = FakeModel({"calls": [("get_datetime", {})]}, {"text": ""})
    events, _ = await run(model)
    assert done(events)["text"].startswith("It's ")
    assert events[-2].type == "delta"  # the fallback is streamed like any answer

    model = FakeModel({"text": "   "})
    events, _ = await run(model)
    assert "couldn't come up with an answer" in done(events)["text"]


async def test_rate_limit_is_retried_after_the_requested_wait():
    model = FakeModel(
        {"error": LLMError("quota", kind="rate_limit", retry_after=3)},
        {"error": LLMError("busy", kind="server")},
        {"text": "Third time lucky."},
    )
    events, slept = await run(model)
    assert slept == [3, 3.0]  # the server's wait, then 1.5s x attempt number
    assert done(events)["text"] == "Third time lucky."


@pytest.mark.parametrize(
    "error",
    [
        LLMError("bad key", kind="auth"),
        LLMError("blocked", kind="blocked"),
        LLMError("come back in a minute", kind="rate_limit", retry_after=60),
    ],
)
async def test_errors_that_retrying_cannot_fix_are_raised_immediately(error):
    model = FakeModel({"error": error})
    with pytest.raises(LLMError):
        await run(model)
    assert len(model.seen) == 1


async def test_retries_are_bounded():
    model = FakeModel(*[{"error": LLMError("down", kind="server")} for _ in range(5)])
    with pytest.raises(LLMError):
        await run(model)
    assert len(model.seen) == 3  # first try plus two retries


async def test_no_retry_once_text_has_been_shown():
    model = FakeModel(
        {"text": "Half an", "error": LLMError("dropped", kind="network"), "error_after_text": True},
        {"text": "never reached"},
    )
    with pytest.raises(LLMError):
        await run(model)
    assert len(model.seen) == 1


async def test_history_and_preferences_reach_the_model():
    model = FakeModel({"text": "ok"})
    history = [ChatMessage("user", "earlier question"), ChatMessage("assistant", "earlier answer")]
    await run(model, "follow up", history=history)
    assert [m.text for m in model.seen[0]["messages"]] == ["earlier question", "earlier answer", "follow up"]
    assert 4 <= len(model.seen[0]["tools"]) <= len(tool_registry.ALL_TOOLS)


async def test_custom_runner_and_duration_are_recorded():
    async def runner(name, args, ctx):
        return ToolResult(data={"x": 1}, summary="did it", source="Test", panel={"type": "answer"}), {"resolved": True}

    model = FakeModel({"calls": [("anything", {"raw": 1})]}, {"text": "done"})
    events, _ = await run(model, runner=runner)
    tool = next(e.data for e in events if e.type == "tool")
    assert tool["args"] == {"resolved": True} and tool["summary"] == "did it"
    assert isinstance(tool["duration_ms"], int) and tool["duration_ms"] >= 0

    async def failing(name, args, ctx):
        raise ToolError("nope")

    model = FakeModel({"calls": [("anything", {})]}, {"text": "sorry"})
    events, _ = await run(model, runner=failing)
    assert next(e.data for e in events if e.type == "tool")["error"] == "nope"


# ---- prompt and follow-ups ------------------------------------------------


def test_system_prompt_carries_user_context():
    prompt = build_system_prompt(
        UserPrefs(default_city="Vellore", github_username="octocat", units="imperial", timezone="Asia/Kolkata")
    )
    assert "Default city: Vellore" in prompt and "GitHub username: octocat" in prompt
    assert "imperial" in prompt and "(Asia/Kolkata)" in prompt
    empty = build_system_prompt(UserPrefs(timezone="Not/AZone"))
    assert "Default city: not set" in empty and "GitHub username: not set" in empty


def test_followups_are_specific_unique_and_capped():
    weather = {"name": "get_weather", "ok": True, "args": {"city": "Pune", "days": 3}, "panel": {"location": {"name": "Pune"}}}
    assert suggest([weather]) == ["7-day forecast for Pune", "News about Pune", "Tell me about Pune"]
    assert "7-day forecast for Pune" not in suggest([{**weather, "args": {"city": "Pune", "days": 7}}])

    repos = {"name": "github_user_repos", "ok": True, "args": {"username": "octocat"},
             "panel": {"username": "octocat", "items": [{"full_name": "octocat/hello"}]}}
    assert suggest([repos]) == ["Open issues in octocat/hello", "Show octocat's most starred repositories"]

    space = {"name": "get_space_picture", "ok": True, "args": {}, "panel": {}}
    assert suggest([space]) == ["Which satellites are above me right now?", "Tell me about the Hubble telescope"]

    # After a chain, nothing already on screen is offered again.
    issues = {"name": "github_repo_issues", "ok": True, "args": {"repo": "octocat/hello", "state": "open"},
              "panel": {"repo": "octocat/hello"}}
    assert suggest([repos, issues]) == ["Show octocat's most starred repositories", "Closed issues in octocat/hello"]

    assert suggest([{**weather, "ok": False}]) == []
    assert len(suggest([weather, repos, space])) == 3
