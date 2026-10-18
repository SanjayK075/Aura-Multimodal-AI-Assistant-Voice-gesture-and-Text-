"""The planning agent: plan validation, ordering, retries, partial failure,
confirmation and the end-to-end flow. A scripted model stands in for Gemini/Groq."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import tools as tool_registry
from app.agent.confirm import Confirmations
from app.agent.planner import (
    Plan, PlanStep, PlanningError, StepState, auto_fill, execute_plan, fallback_answer, keyword_plan,
    order_steps, run_planned, validate_plan,
)
from app.llm.base import ChatMessage, LLMError, TextDelta, ToolCall, TurnEnd
from app.main import create_app
from app.tools.base import ToolContext, ToolError, ToolResult, UserPrefs

from .conftest import make_ctx, make_settings, parse_sse

AVAILABLE = {"get_weather", "get_air_quality", "github_user_repos", "github_repo_issues", "forget_memory", "list_memories"}


def good(steps):
    return {"goal": "g", "steps": steps}


def step(i, tool="get_weather", args=None, deps=None):
    return {"id": f"s{i}", "tool": tool, "args_json": json.dumps(args or {"city": "Pune"}), "depends_on": deps or [], "purpose": "p"}


# ---- validation -----------------------------------------------------------------

def test_valid_plan_is_accepted():
    plan, problems = validate_plan(good([step(1), step(2, args={"city": "Delhi"})]), AVAILABLE)
    assert not problems and [s.id for s in plan.steps] == ["s1", "s2"]


def test_unknown_tool_bad_json_and_missing_dependency_are_reported():
    _, problems = validate_plan(good([step(1, tool="nope")]), AVAILABLE)
    assert "nope" in problems[0]
    bad = step(1)
    bad["args_json"] = "{not json"
    assert "valid JSON" in validate_plan(good([bad]), AVAILABLE)[1][0]
    assert "s9" in validate_plan(good([step(1, deps=["s9"])]), AVAILABLE)[1][0]


def test_cycles_and_too_many_steps_are_rejected():
    _, problems = validate_plan(good([step(1, deps=["s2"]), step(2, deps=["s1"])]), AVAILABLE)
    assert "cycle" in problems[0]
    _, problems = validate_plan(good([step(i) for i in range(1, 12)]), AVAILABLE)
    assert "at most" in problems[0]


def test_placeholder_creates_a_dependency():
    plan, _ = validate_plan(good([step(1, "github_user_repos", {"username": "x"}),
                                  step(2, "github_repo_issues", {"repo": "$s1"})]), AVAILABLE)
    assert plan.steps[1].depends_on == ["s1"] and plan.steps[1].refs == ["s1"]


def test_independent_steps_share_a_wave():
    plan, _ = validate_plan(good([step(1), step(2), step(3, deps=["s1", "s2"])]), AVAILABLE)
    assert order_steps(plan.steps) == [["s1", "s2"], ["s3"]]


# ---- keyword planner ---------------------------------------------------------------

def test_keyword_plan_compares_cities():
    plan = keyword_plan("Compare the weather and air quality in Pune, Delhi and Chennai, then recommend one", UserPrefs())
    pairs = {(s.tool, s.args["city"]) for s in plan.steps}
    assert pairs == {(t, c) for t in ("get_weather", "get_air_quality") for c in ("Pune", "Delhi", "Chennai")}


def test_keyword_plan_chains_repo_and_issues():
    plan = keyword_plan("Find my most starred repo and show its issues", UserPrefs(github_username="octocat"))
    assert [s.tool for s in plan.steps] == ["github_user_repos", "github_repo_issues"]
    assert plan.steps[1].depends_on == ["s1"]


# ---- execution ---------------------------------------------------------------------

def mk_plan(*steps):
    return Plan("g", list(steps), "model")


def ps(i, tool="get_weather", args=None, deps=None):
    a = args or {"city": "Pune"}
    return PlanStep(f"s{i}", tool, a, deps or [], "p", [])


def ok(summary="fine", data=None):
    return ToolResult(data=data or {"v": 1}, summary=summary, source="T", panel={"type": "answer"})


async def collect(plan, runner, confirmations=None, resolve=None, **kw):
    async def default_resolve(step, deps):
        return auto_fill(step, deps)

    sleeps: list[float] = []

    async def sleep(s):
        sleeps.append(s)

    states: dict[str, StepState] = {}
    events = [e async for e in execute_plan(
        plan, make_ctx(), run_id="r1", confirmations=confirmations, resolve=resolve or default_resolve,
        runner=runner, sleep=sleep, states=states, **kw)]
    return events, states, sleeps


async def test_independent_steps_run_in_parallel():
    running = 0
    peak = 0

    async def runner(name, args, ctx):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        return ok(), args

    _, states, _ = await collect(mk_plan(ps(1), ps(2), ps(3)), runner)
    assert peak == 3 and all(s.state == "done" for s in states.values())


async def test_dependent_step_waits_and_receives_the_result():
    order = []

    async def runner(name, args, ctx):
        order.append((name, args))
        if name == "github_user_repos":
            return ok(data={"repositories": [{"full_name": "a/low", "stars": 1}, {"full_name": "a/top", "stars": 9}]}), args
        return ok(), args

    first = ps(1, "github_user_repos", {"username": "a"})
    second = PlanStep("s2", "github_repo_issues", {"repo": "$s1"}, ["s1"], "p", ["s1"])
    _, states, _ = await collect(mk_plan(first, second), runner)
    assert order[1][1] == {"repo": "a/top"} and states["s2"].state == "done"


async def test_retryable_errors_are_retried_then_succeed():
    calls = 0

    async def runner(name, args, ctx):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ToolError("busy", retryable=True)
        return ok(), args

    events, states, sleeps = await collect(mk_plan(ps(1)), runner)
    assert states["s1"].state == "done" and states["s1"].attempts == 3 and len(sleeps) == 2
    assert any(e.data.get("state") == "retrying" for e in events if e.type == "step")


async def test_permanent_errors_are_not_retried_and_dependents_are_skipped():
    calls = 0

    async def runner(name, args, ctx):
        nonlocal calls
        calls += 1
        if args.get("city") == "Pune":
            raise ToolError("no such city", retryable=False)
        return ok(), args

    plan = mk_plan(ps(1), ps(2, args={"city": "Delhi"}),
                   PlanStep("s3", "get_air_quality", {"city": "x"}, ["s1"], "p", []))
    _, states, _ = await collect(plan, runner)
    assert [states[k].state for k in ("s1", "s2", "s3")] == ["failed", "done", "skipped"]
    assert calls == 2


async def test_timeouts_count_as_retryable():
    async def runner(name, args, ctx):
        await asyncio.sleep(1)
        return ok(), args

    _, states, _ = await collect(mk_plan(ps(1)), runner, step_timeout=0.01, attempts=2)
    assert states["s1"].state == "failed" and states["s1"].attempts == 2


async def test_a_crash_fails_one_step_only():
    async def runner(name, args, ctx):
        if args["city"] == "Pune":
            raise RuntimeError("bug")
        return ok(), args

    _, states, _ = await collect(mk_plan(ps(1), ps(2, args={"city": "Delhi"})), runner)
    assert states["s1"].state == "failed" and states["s2"].state == "done"


async def test_forget_waits_for_confirmation_and_denial_blocks_it():
    ran = []

    async def runner(name, args, ctx):
        ran.append(args)
        return ok(), args

    step_ = ps(1, "forget_memory", {"all": True})
    for answer, expected in ((True, "done"), (False, "denied")):
        ran.clear()
        conf = Confirmations(timeout=2)

        async def answerer():
            while not conf.pending("r1"):
                await asyncio.sleep(0.01)
            conf.resolve("r1", "s1", answer)

        task = asyncio.create_task(answerer())
        events, states, _ = await collect(mk_plan(step_), runner, confirmations=conf)
        await task
        assert states["s1"].state == expected
        assert any(e.type == "confirm" for e in events)
        assert bool(ran) == answer


async def test_no_answer_counts_as_no():
    async def runner(name, args, ctx):
        raise AssertionError("must not run")

    conf = Confirmations(timeout=0.05)
    _, states, _ = await collect(mk_plan(ps(1, "forget_memory", {"all": True})), runner, confirmations=conf)
    assert states["s1"].state == "denied"


async def test_only_forgetting_needs_confirmation():
    forget = tool_registry.REGISTRY["forget_memory"]
    assert forget.needs_confirmation({"all": True})
    assert not tool_registry.REGISTRY["get_weather"].needs_confirmation({"city": "Pune"})


# ---- the model-driven flow ---------------------------------------------------------------

class Scripted:
    name, model = "fake", "fake-1"

    def __init__(self, *turns):
        self.turns, self.seen = list(turns), []

    async def stream(self, system, messages, tools, context=None, tool_choice=None):
        self.seen.append({"choice": tool_choice, "tools": [t.name for t in tools], "messages": list(messages)})
        turn = self.turns.pop(0)
        if turn.get("error"):
            raise turn["error"]
        for word in (turn.get("text") or "").split(" ") if turn.get("text") else []:
            yield TextDelta(word + " ")
        calls = [ToolCall(f"c{i}", n, a) for i, (n, a) in enumerate(turn.get("calls", []))]
        yield TurnEnd(ChatMessage("assistant", text=turn.get("text", ""), tool_calls=calls), {"total_tokens": 5})


def plan_call(*steps):
    return {"calls": [("submit_plan", {"goal": "compare", "steps": list(steps)})]}


async def drive(model, text="compare weather", runner=None, **kw):
    async def sleep(s):
        return None

    return [e async for e in run_planned(
        provider=model, system="sys", history=[], user_text=text, ctx=make_ctx(default_city="Chennai"),
        run_id="r1", confirmations=None, specs=tool_registry.specs(), runner=runner or tool_registry.execute,
        sleep=sleep, **kw)]


async def test_full_run_plans_executes_and_answers():
    model = Scripted(
        plan_call(step(1, args={"city": "Pune"}), step(2, args={"city": "Delhi"})),
        {"text": "Pune is better."},
    )
    events = await drive(model)
    kinds = [e.type for e in events]
    assert kinds.index("plan") < kinds.index("step") < kinds.index("done")
    assert model.seen[0]["choice"] == "submit_plan" and model.seen[0]["tools"] == ["submit_plan"]
    done = events[-1].data
    assert done["text"].strip() == "Pune is better." and done["mode"] == "plan" and done["steps"] == 2
    assert set(done["timings"]) == {"plan_ms", "execute_ms", "answer_ms"}
    assert [s["state"] for s in done["trace"]["steps"]] == ["done", "done"]
    # the writer saw both results
    assert "Pune" in model.seen[1]["messages"][-1].text and "Delhi" in model.seen[1]["messages"][-1].text


async def test_invalid_plan_is_sent_back_and_repaired():
    model = Scripted(plan_call(step(1, tool="made_up")), plan_call(step(1)), {"text": "ok"})
    events = await drive(model)
    plan = next(e for e in events if e.type == "plan")
    assert plan.data["repairs"] == 1
    assert "made_up" in str(model.seen[1]["messages"][-2].tool_outputs[0].content)


async def test_unfixable_plan_raises_so_the_caller_can_fall_back():
    model = Scripted(*[plan_call(step(1, tool="made_up"))] * 3)
    with pytest.raises(PlanningError):
        await drive(model)


async def test_empty_plan_raises():
    with pytest.raises(PlanningError):
        await drive(Scripted(plan_call()))


async def test_failed_step_is_reported_not_hidden():
    async def runner(name, args, ctx):
        if args["city"] == "Pune":
            raise ToolError("weather service is down")
        return ok("Delhi is sunny"), args

    model = Scripted(plan_call(step(1), step(2, args={"city": "Delhi"})), {"text": "Only Delhi."})
    events = await drive(model, runner=runner)
    digest = model.seen[1]["messages"][-1].text
    assert "weather service is down" in digest and "failed" in digest
    assert events[-1].data["trace"]["steps"][0]["state"] == "failed"


async def test_writer_failure_falls_back_to_the_results():
    model = Scripted(plan_call(step(1)), {"error": LLMError("down", kind="auth")})
    events = await drive(model)
    assert events[-1].data["text"]


async def test_demo_mode_plans_without_a_model():
    from app.llm.demo import DemoProvider

    events = await drive(DemoProvider(), text="Compare the air quality in Pune and Delhi, then recommend one")
    done = events[-1].data
    assert done["provider"] == "demo" and done["steps"] == 2
    assert "Recommendation" in done["text"]


def test_fallback_recommends_the_cleaner_city():
    plan = keyword_plan("compare weather and air quality in Pune and Delhi and recommend", UserPrefs())
    states = {}
    for st in plan.steps:
        city = st.args["city"]
        out = ({"location": city, "now": {"temperature": 25}, "forecast": [{"rain_chance": 10}]} if st.tool == "get_weather"
               else {"location": city, "us_aqi": 40 if city == "Pune" else 180, "category": "x"})
        s = StepState(step=st, label="l", state="done", args=st.args, summary=f"{city} ok", output=out)
        states[st.id] = s
    assert "Recommendation: Pune" in fallback_answer("compare and recommend", plan, states)


# ---- the HTTP API --------------------------------------------------------------------------

ME = {"X-Client-Id": "browser-aaaa-1111"}


@pytest.fixture
def client():
    with TestClient(create_app(make_settings())) as c:
        yield c


def test_chat_uses_the_planner_for_comparisons_and_saves_the_run(client):
    r = client.post("/api/chat", json={"message": "Compare the weather and air quality in Pune and Delhi, then recommend one"}, headers=ME)
    events = parse_sse(r.text)
    names = [e for e, _ in events]
    assert "plan" in names and "step" in names and names[-1] == "done"
    done = events[-1][1]
    assert done["mode"] == "plan" and done["message_id"]
    runs = client.get("/api/runs", headers=ME).json()["runs"]
    assert len(runs) == 1 and runs[0]["status"] == "done"
    detail = client.get(f"/api/runs/{runs[0]['id']}", headers=ME).json()
    assert len(detail["steps"]) == 4 and detail["answer"]
    assert client.get(f"/api/runs/{runs[0]['id']}", headers={"X-Client-Id": "other-browser-9999"}).status_code == 404


def test_single_mode_skips_the_planner(client):
    r = client.post("/api/chat", json={"message": "weather in Pune and Delhi", "mode": "single"}, headers=ME)
    assert "plan" not in [e for e, _ in parse_sse(r.text)]


def test_memory_endpoints(client):
    assert client.post("/api/memories", json={"text": "my exam is on the 20th"}, headers=ME).status_code == 200
    items = client.get("/api/memories", headers=ME).json()["memories"]
    assert items[0]["text"] == "my exam is on the 20th"
    assert client.delete(f"/api/memories/{items[0]['id']}", headers=ME).json() == {"deleted": True}
    assert client.get("/api/memories", headers=ME).json()["memories"] == []


def test_tools_endpoint_runs_read_only_tools_only(client):
    r = client.get("/api/tools/get_air_quality?city=Pune", headers=ME)
    assert r.status_code == 200 and r.json()["panel"]["type"] == "air"
    assert client.get("/api/tools/forget_memory", headers=ME).status_code == 404
    assert client.get("/api/tools/nonexistent", headers=ME).status_code == 404


def test_forget_in_chat_asks_first_and_is_refused_without_an_answer():
    settings = make_settings(confirm_timeout_seconds=0.2)
    with TestClient(create_app(settings)) as c:
        c.post("/api/memories", json={"text": "I like tea"}, headers=ME)
        r = c.post("/api/chat", json={"message": "forget everything"}, headers=ME)
        names = [e for e, _ in parse_sse(r.text)]
        assert "confirm" in names
        assert len(c.get("/api/memories", headers=ME).json()["memories"]) == 1


def test_geocode_endpoint_and_tool_routing(client):
    place = client.get("/api/geocode?q=Pune").json()
    assert place["name"] == "Pune" and 18 < place["lat"] < 19
    assert client.get("/api/geocode?q=Nowhereville").status_code == 404
