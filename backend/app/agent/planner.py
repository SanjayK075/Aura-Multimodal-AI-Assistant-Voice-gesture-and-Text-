"""The planning agent: plan, execute, then answer.

The plain agent loop (loop.py) lets the model pick one round of tools at a
time. That is ideal for "what's the weather in Pune?" and wasteful for
"compare the weather and air quality in three cities and recommend one":
the model would need several round trips, and the work it did would be
invisible. This module handles such requests in three phases:

  1. PLAN      One model call returns a structured plan: steps, each a tool
               call with arguments and dependencies. The model is forced to
               call submit_plan, so the plan arrives as schema-checked JSON.
               It is then validated (known tools, real dependencies, no
               cycles); problems are sent back once or twice for repair.
  2. EXECUTE   Steps run as soon as their dependencies finish, so independent
               steps run in parallel. Each step has a timeout and retries on
               transient errors. A step whose input failed is skipped, not
               guessed. Consequential steps wait for the person's approval.
               Arguments that depend on earlier results ("$s1") are filled in
               by a small model call that is forced to call that tool.
  3. ANSWER    A final model call writes the answer from the step results,
               saying plainly what could not be fetched.

Every phase emits events, which the browser draws as a live trace with
timings. Without an API key a keyword planner and a rule-based writer stand in,
so the whole flow still works in demo mode.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable

from .. import tools as tool_registry
from ..llm.base import ChatMessage, LLMError, LLMProvider, TextDelta, ToolOutput, ToolSpec, TurnEnd
from ..llm.demo import route
from ..tools.base import ToolContext, ToolError, ToolResult, UserPrefs, clip
from .confirm import Confirmations, describe_action
from .followups import suggest
from .loop import MAX_MODEL_RETRIES, MAX_RETRY_WAIT_SECONDS, AgentEvent

MAX_PLAN_STEPS = 8
MAX_REPAIRS = 2
STEP_ATTEMPTS = 3
STEP_TIMEOUT_SECONDS = 25.0
REF = re.compile(r"\$(s\d+)\b")

Runner = Callable[[str, Any, ToolContext], Awaitable[tuple[ToolResult, dict[str, Any]]]]
Sleep = Callable[[float], Awaitable[None]]


class PlanningError(Exception):
    """The model couldn't produce a usable plan; the caller falls back to the plain loop."""


# ---- the plan ---------------------------------------------------------------


@dataclass
class PlanStep:
    id: str
    tool: str
    args: dict[str, Any]
    depends_on: list[str]
    purpose: str
    refs: list[str] = field(default_factory=list)  # steps whose results fill "$sN" placeholders

    def to_dict(self) -> dict[str, Any]:
        tool = tool_registry.REGISTRY.get(self.tool)
        return {
            "id": self.id,
            "tool": self.tool,
            "label": tool.status_label if tool else self.tool,
            "args": self.args,
            "depends_on": self.depends_on,
            "purpose": self.purpose,
            "needs_input": bool(self.refs),
        }


@dataclass
class Plan:
    goal: str
    steps: list[PlanStep]
    source: str  # model | template | keywords

    def to_dict(self) -> dict[str, Any]:
        return {"goal": self.goal, "source": self.source, "steps": [s.to_dict() for s in self.steps]}


def plan_spec(tool_names: list[str]) -> ToolSpec:
    """The schema the model's plan must follow, as a function it is forced to call."""
    return ToolSpec(
        name="submit_plan",
        description="Submit the plan of tool calls that will accomplish the user's task.",
        parameters={
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "The user's task restated in one short sentence."},
                "steps": {
                    "type": "array",
                    "description": f"At most {MAX_PLAN_STEPS} tool calls. Empty if no tool is needed.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "s1, s2, s3 and so on."},
                            "tool": {"type": "string", "enum": tool_names},
                            "args_json": {
                                "type": "string",
                                "description": 'The arguments as a JSON object, e.g. {"city": "Pune"}. '
                                'Write "$s1" for a value that must come from step s1\'s result.',
                            },
                            "depends_on": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Ids of steps whose results this step needs. Leave empty when independent.",
                            },
                            "purpose": {"type": "string", "description": "Why this step is needed, in a few words."},
                        },
                        "required": ["id", "tool", "args_json", "purpose"],
                    },
                },
            },
            "required": ["goal", "steps"],
        },
    )


def _parse_args(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _refs_in(value: Any) -> set[str]:
    if isinstance(value, str):
        return set(REF.findall(value))
    if isinstance(value, dict):
        return set().union(*(_refs_in(v) for v in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(_refs_in(v) for v in value)) if value else set()
    return set()


def order_steps(steps: list[PlanStep]) -> list[list[str]]:
    """Group steps into waves that can run together. Raises ValueError on a cycle."""
    remaining = {s.id: set(s.depends_on) for s in steps}
    waves: list[list[str]] = []
    done: set[str] = set()
    while remaining:
        wave = [sid for sid, deps in remaining.items() if deps <= done]
        if not wave:
            raise ValueError("the dependencies form a cycle: " + ", ".join(sorted(remaining)))
        waves.append(wave)
        done.update(wave)
        for sid in wave:
            del remaining[sid]
    return waves


def validate_plan(raw: Any, available: set[str]) -> tuple[Plan | None, list[str]]:
    """Check a submitted plan. Returns the plan, or the problems to send back to the model."""
    if not isinstance(raw, dict):
        return None, ["The plan must be an object with 'goal' and 'steps'."]
    problems: list[str] = []
    raw_steps = raw.get("steps")
    if not isinstance(raw_steps, list):
        return None, ["'steps' must be a list (it may be empty)."]
    if len(raw_steps) > MAX_PLAN_STEPS:
        problems.append(f"Use at most {MAX_PLAN_STEPS} steps; there were {len(raw_steps)}.")

    steps: list[PlanStep] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_steps[:MAX_PLAN_STEPS]):
        if not isinstance(item, dict):
            problems.append(f"Step {index + 1} is not an object.")
            continue
        sid = str(item.get("id") or f"s{index + 1}").strip()
        tool = str(item.get("tool") or "").strip()
        if sid in seen:
            problems.append(f"Step id {sid} is used twice.")
            continue
        seen.add(sid)
        if tool not in available:
            problems.append(f"Step {sid} uses '{tool}', which is not one of the available tools.")
            continue
        args = _parse_args(item.get("args_json", item.get("args")))
        if args is None:
            problems.append(f"Step {sid}: args_json is not a valid JSON object.")
            continue
        refs = sorted(_refs_in(args))
        depends = [str(d).strip() for d in item.get("depends_on") or [] if str(d).strip()]
        depends = sorted(set(depends) | set(refs))
        steps.append(PlanStep(sid, tool, args, depends, clip(item.get("purpose") or tool, 140), refs))

    ids = {s.id for s in steps}
    for step in steps:
        missing = [d for d in step.depends_on if d not in ids]
        if missing:
            problems.append(f"Step {step.id} depends on {', '.join(missing)}, which is not a step in the plan.")
        if step.id in step.depends_on:
            problems.append(f"Step {step.id} depends on itself.")
    if not problems:
        try:
            order_steps(steps)
        except ValueError as error:
            problems.append(f"The plan can't run: {error}.")
    if problems:
        return None, problems
    goal = clip(raw.get("goal") or "", 200)
    return Plan(goal=goal, steps=steps, source="model"), []


# ---- planning ---------------------------------------------------------------


def catalog(specs: list[ToolSpec]) -> str:
    """A compact list of tools for the planner: far fewer tokens than full schemas."""
    lines = []
    for spec in specs:
        params = []
        for name, schema in (spec.parameters.get("properties") or {}).items():
            kind = schema.get("type", "string")
            options = f" one of {'/'.join(map(str, schema['enum']))}" if schema.get("enum") else ""
            params.append(f"{name}: {kind}{options}")
        lines.append(f"- {spec.name}({', '.join(params)}): {spec.description}")
    return "\n".join(lines)


def planner_system(prefs: UserPrefs, specs: list[ToolSpec], memories: list[str]) -> str:
    now = datetime.now(timezone.utc).strftime("%A %d %B %Y, %H:%M UTC")
    remembered = "\n".join(f"- {m}" for m in memories[:15]) or "- (nothing saved)"
    return f"""You are the planning module of Aura, a voice assistant. Turn the user's task into a plan of tool calls by calling submit_plan.

Rules
- Use only the tools listed below. Every live fact must come from a tool.
- One step per tool call. Calls for different cities or items are separate steps.
- Steps without depends_on run at the same time. Add a dependency only when a step truly needs another's result.
- When an argument must come from an earlier step, write "$s1" (that step's id) as the value and list s1 in depends_on.
- Don't add a step for writing the answer or recommending; a separate writer does that from the results.
- If the task needs no tools at all, submit an empty steps list.
- Leave out arguments that have defaults you're happy with.

Tools
{catalog(specs)}

About the user
- Now: {now}
- Default city: {prefs.default_city or "not set"}
- GitHub username: {prefs.github_username or "not set"}
- Saved facts:
{remembered}"""


async def complete(
    provider: LLMProvider,
    system: str,
    messages: list[ChatMessage],
    tools: list[ToolSpec],
    tool_choice: str | None,
    sleep: Sleep,
) -> tuple[ChatMessage, dict[str, int]]:
    """One non-streamed model call, retried on short rate limits and outages."""
    attempt = 0
    while True:
        try:
            turn: ChatMessage | None = None
            usage: dict[str, int] = {}
            async for event in provider.stream(system, messages, tools, None, tool_choice):
                if isinstance(event, TurnEnd):
                    turn, usage = event.message, event.usage
            if turn is None:
                raise LLMError("The model ended its reply unexpectedly.", kind="server")
            return turn, usage
        except LLMError as error:
            attempt += 1
            wait = error.retry_after if error.retry_after is not None else 1.5 * attempt
            if not error.retryable or attempt > MAX_MODEL_RETRIES or wait > MAX_RETRY_WAIT_SECONDS:
                raise
            await sleep(wait)


def _add_usage(total: dict[str, int], usage: dict[str, int]) -> None:
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        total[key] = total.get(key, 0) + int(usage.get(key) or 0)


async def make_plan(
    provider: LLMProvider,
    task: str,
    prefs: UserPrefs,
    specs: list[ToolSpec],
    memories: list[str],
    sleep: Sleep,
    usage: dict[str, int],
) -> tuple[Plan, int]:
    """Returns the plan and how many repair rounds it took."""
    if provider.name == "demo":
        return keyword_plan(task, prefs), 0

    names = [s.name for s in specs]
    spec = plan_spec(names)
    system = planner_system(prefs, specs, memories)
    messages = [ChatMessage(role="user", text=task)]
    problems: list[str] = []
    for repair in range(MAX_REPAIRS + 1):
        turn, used = await complete(provider, system, messages, [spec], "submit_plan", sleep)
        _add_usage(usage, used)
        call = next((c for c in turn.tool_calls if c.name == "submit_plan"), None)
        if call is None:
            problems = ["Call submit_plan with the plan; don't answer in text."]
            messages.append(ChatMessage(role="user", text=problems[0]))
            continue
        plan, problems = validate_plan(call.args, set(names))
        if plan is not None:
            return plan, repair
        # Send the problems back as the result of the submit_plan call and ask again.
        messages += [
            turn,
            ChatMessage(
                role="tool",
                tool_outputs=[ToolOutput(call=call, content={"accepted": False, "problems": problems})],
            ),
            ChatMessage(role="user", text="Fix those problems and call submit_plan again."),
        ]
    raise PlanningError("; ".join(problems) or "no plan")


# Words that mark the start of a place name in a request, and places the
# keyword planner recognises even when typed in lower case.
_KNOWN_PLACES = (
    "chennai vellore mumbai delhi new delhi bengaluru bangalore hyderabad kolkata pune ahmedabad jaipur kochi "
    "coimbatore madurai london paris tokyo new york sydney singapore dubai berlin san francisco toronto"
).split(" ")
_PLACE_LIST = re.compile(
    r"\b(?:in|for|between|across|at|of)\s+((?:[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)"
    r"(?:\s*(?:,|and|&|or)\s*(?:[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*))*)"
)
_SPLIT = re.compile(r"\s*(?:,|\band then\b|\bthen\b|\bafter that\b|\band also\b|\band\b)\s*", re.IGNORECASE)


def extract_places(task: str) -> list[str]:
    places: list[str] = []
    for match in _PLACE_LIST.finditer(task):
        for name in re.split(r"\s*(?:,|\band\b|&|\bor\b)\s*", match.group(1)):
            name = name.strip()
            if name and name.lower() not in ("the", "my", "me") and name not in places:
                places.append(name)
    lowered = task.lower()
    for known in sorted(_KNOWN_PLACES, key=len, reverse=True):
        if known and re.search(rf"\b{re.escape(known)}\b", lowered):
            title = known.title()
            if not any(p.lower() == known for p in places) and not any(known in p.lower() for p in places):
                places.append(title)
    return places


def keyword_plan(task: str, prefs: UserPrefs) -> Plan:
    """A plan without a language model, from keywords. Used in demo mode."""
    lowered = task.lower()
    steps: list[PlanStep] = []

    def add(tool: str, args: dict[str, Any], purpose: str, depends: list[str] | None = None) -> str:
        sid = f"s{len(steps) + 1}"
        refs = sorted(_refs_in(args))
        steps.append(PlanStep(sid, tool, args, sorted(set(depends or []) | set(refs)), purpose, refs))
        return sid

    places = extract_places(task)
    wants_air = bool(re.search(r"\bair\b|aqi|pollution|smog", lowered))
    wants_weather = bool(re.search(r"weather|forecast|rain|temperature|hot|cold|outdoor|event|picnic", lowered))

    if places and (wants_air or wants_weather):
        for place in places[:4]:
            if wants_weather or (not wants_air):
                add("get_weather", {"city": place}, f"Weather in {place}")
            if wants_air:
                add("get_air_quality", {"city": place}, f"Air quality in {place}")
    elif re.search(r"repo", lowered) and re.search(r"issue", lowered):
        user = {"username": prefs.github_username} if prefs.github_username else {}
        first = add("github_user_repos", {**user, "sort": "stars"}, "Find the repositories")
        add("github_repo_issues", {"repo": f"${first}"}, "Open issues of the top repository")
    else:
        for clause in _SPLIT.split(task):
            if not clause.strip():
                continue
            choice = route(clause, {})
            if choice:
                tool, args = choice
                add(tool, args, clip(clause.strip(), 60))
    # Two clauses asking for the same thing would run it twice.
    unique: list[PlanStep] = []
    keys: set[str] = set()
    for step in steps:
        key = f"{step.tool}|{json.dumps(step.args, sort_keys=True)}"
        if key not in keys:
            keys.add(key)
            unique.append(step)
    return Plan(goal=clip(task, 160), steps=unique[:MAX_PLAN_STEPS], source="keywords")


# ---- execution --------------------------------------------------------------


@dataclass
class StepState:
    step: PlanStep
    label: str
    state: str = "pending"  # pending running retrying waiting done failed skipped denied
    attempts: int = 0
    started_ms: int | None = None
    duration_ms: int | None = None
    args: dict[str, Any] = field(default_factory=dict)
    summary: str = ""
    error: str | None = None
    source: str | None = None
    source_url: str | None = None
    cached: bool = False
    panel: dict[str, Any] | None = None
    output: dict[str, Any] = field(default_factory=dict)
    prompt: str = ""

    @property
    def finished(self) -> bool:
        return self.state in ("done", "failed", "skipped", "denied")

    def record(self, with_panel: bool = False) -> dict[str, Any]:
        out = {
            "id": self.step.id,
            "tool": self.step.tool,
            "label": self.label,
            "purpose": self.step.purpose,
            "depends_on": self.step.depends_on,
            "state": self.state,
            "attempts": self.attempts,
            "started_ms": self.started_ms,
            "duration_ms": self.duration_ms,
            "args": self.args or self.step.args,
            "summary": self.summary,
            "error": self.error,
            "source": self.source,
            "cached": self.cached,
        }
        if with_panel and self.panel:
            out["panel"] = {**self.panel, "source": self.source, "source_url": self.source_url}
        return out


Resolver = Callable[[PlanStep, dict[str, StepState]], Awaitable[dict[str, Any]]]


def auto_fill(step: PlanStep, deps: dict[str, StepState]) -> dict[str, Any]:
    """Fill "$sN" placeholders from earlier results without a model (demo mode, and
    the fallback if the model can't do it). Handles the common hand-offs."""
    filled: dict[str, Any] = {}
    for name, value in step.args.items():
        refs = _refs_in(value)
        if not refs:
            filled[name] = value
            continue
        source = deps.get(sorted(refs)[0])
        data = source.output if source else {}
        replacement: Any = None
        if name == "repo" and data.get("repositories"):
            repos = sorted(data["repositories"], key=lambda r: r.get("stars") or 0, reverse=True)
            replacement = repos[0]["full_name"]
        elif name in ("city", "near") and data.get("location"):
            replacement = str(data["location"]).split(",")[0]
        elif name == "username" and data.get("username"):
            replacement = data["username"]
        if replacement is None:
            raise ToolError(f"Couldn't work out '{name}' from the result of {sorted(refs)[0]}.")
        filled[name] = replacement
    return filled


def model_resolver(provider: LLMProvider, sleep: Sleep, usage: dict[str, int]) -> Resolver:
    """Fill placeholders with a model call that must call the step's own tool."""

    async def resolve(step: PlanStep, deps: dict[str, StepState]) -> dict[str, Any]:
        tool = tool_registry.REGISTRY[step.tool]
        spec = ToolSpec(tool.name, tool.description, tool.parameters)
        results = "\n".join(
            f"{sid} ({state.step.tool}): {json.dumps(state.output, ensure_ascii=False, default=str)[:1500]}"
            for sid, state in deps.items()
        )
        prompt = (
            f"This step of a plan needs its arguments filled in.\nPurpose: {step.purpose}\n"
            f"Draft arguments (placeholders like $s1 stand for that step's result): {json.dumps(step.args)}\n"
            f"Results of the steps it depends on:\n{results}\n\nCall {tool.name} with concrete arguments."
        )
        try:
            turn, used = await complete(
                provider, "You fill in tool arguments from earlier results.", [ChatMessage(role="user", text=prompt)],
                [spec], tool.name, sleep,
            )
        except LLMError:
            return auto_fill(step, deps)
        _add_usage(usage, used)
        call = next((c for c in turn.tool_calls if c.name == tool.name), None)
        if call is None or _refs_in(call.args):
            return auto_fill(step, deps)
        return dict(call.args)

    return resolve


async def execute_plan(
    plan: Plan,
    ctx: ToolContext,
    *,
    run_id: str,
    confirmations: Confirmations | None,
    resolve: Resolver,
    runner: Runner = tool_registry.execute,
    sleep: Sleep = asyncio.sleep,
    step_timeout: float = STEP_TIMEOUT_SECONDS,
    attempts: int = STEP_ATTEMPTS,
    states: dict[str, StepState] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run every step as soon as its inputs are ready. Yields step, confirm and tool events."""
    states = states if states is not None else {}
    for step in plan.steps:
        tool = tool_registry.REGISTRY.get(step.tool)
        states[step.id] = StepState(step=step, label=tool.status_label if tool else step.tool)
    started = time.perf_counter()
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    running: dict[str, asyncio.Task[None]] = {}

    def elapsed() -> int:
        return round((time.perf_counter() - started) * 1000)

    async def emit(kind: str, data: dict[str, Any]) -> None:
        await queue.put((kind, data))

    async def run_step(state: StepState) -> None:
        step = state.step
        step_started = time.perf_counter()
        state.state, state.started_ms = "running", elapsed()
        await emit("step", state.record())
        try:
            args = dict(step.args)
            if step.refs:
                args = await resolve(step, {ref: states[ref] for ref in step.refs})
            state.args = args
            tool = tool_registry.REGISTRY[step.tool]
            cleaned = tool_registry.clean_args(tool, args)

            if tool.needs_confirmation(cleaned):
                state.prompt = tool.describe(cleaned) if tool.describe else describe_action(state.label, cleaned)
                approved: bool | None = False
                if confirmations is not None:
                    confirmations.open(run_id, step.id)
                    state.state = "waiting"
                    await emit("confirm", {"run_id": run_id, "step_id": step.id, "tool": step.tool, "label": state.label, "args": cleaned, "prompt": state.prompt})
                    await emit("step", state.record())
                    approved = await confirmations.wait(run_id, step.id)
                if not approved:
                    state.state = "denied"
                    state.error = "You didn't approve this, so it wasn't done." if approved is False else "No answer came, so it wasn't done."
                    state.summary = state.error
                    return
                state.state = "running"
                await emit("step", state.record())

            for attempt in range(1, attempts + 1):
                state.attempts = attempt
                try:
                    result, used = await asyncio.wait_for(runner(step.tool, args, ctx), step_timeout)
                except asyncio.TimeoutError:
                    error = ToolError(f"{state.label} took too long.", retryable=True)
                except ToolError as caught:
                    error = caught
                else:
                    state.state, state.args = "done", used
                    state.summary, state.source, state.source_url = result.summary, result.source, result.source_url
                    state.cached, state.panel, state.output = result.cached, result.panel, result.data
                    return
                state.error = error.message
                if error.retryable and attempt < attempts:
                    state.state = "retrying"
                    await emit("step", state.record())
                    await sleep(0.6 * (2 ** (attempt - 1)))
                    state.state = "running"
                    continue
                state.state = "failed"
                state.summary = error.message
                return
        except ToolError as error:  # from argument resolution
            state.state, state.error, state.summary = "failed", error.message, error.message
        except Exception as error:  # a bug must fail one step, not the whole run
            state.state, state.error = "failed", f"Something went wrong in this step ({type(error).__name__})."
            state.summary = state.error
        finally:
            state.duration_ms = round((time.perf_counter() - step_started) * 1000)
            await emit("step", state.record(with_panel=True))
            if state.state in ("done", "failed"):
                await emit("tool", {
                    "id": step.id, "name": step.tool, "label": state.label, "args": state.args or step.args,
                    "ok": state.state == "done", "summary": state.summary, "error": state.error,
                    "cached": state.cached, "source": state.source, "source_url": state.source_url,
                    "panel": state.panel if state.state == "done" else None, "duration_ms": state.duration_ms,
                })
            await queue.put(("_finished", step.id))

    def launch_ready() -> list[dict[str, Any]]:
        skipped = []
        for state in states.values():
            if state.state != "pending" or state.step.id in running:
                continue
            deps = [states[d] for d in state.step.depends_on]
            broken = [d for d in deps if d.state in ("failed", "skipped", "denied")]
            if broken:
                state.state = "skipped"
                state.error = f"Skipped: it needs {', '.join(d.step.id for d in broken)}, which didn't succeed."
                state.summary = state.error
                skipped.append(state.record())
            elif all(d.state == "done" for d in deps):
                running[state.step.id] = asyncio.create_task(run_step(state))
        return skipped

    try:
        while True:
            for record in launch_ready():
                yield AgentEvent("step", record)
            # Skipping can unblock nothing new but may leave more to skip; loop until stable.
            if not running:
                if any(s.state == "pending" for s in states.values()):
                    continue
                break
            kind, data = await queue.get()
            if kind == "_finished":
                running.pop(data, None)
                continue
            yield AgentEvent(kind, data)
    finally:
        for task in running.values():
            task.cancel()
        if confirmations is not None:
            confirmations.cancel_run(run_id)


# ---- the answer ---------------------------------------------------------------


def results_digest(task: str, plan: Plan, states: dict[str, StepState]) -> str:
    lines = [f"Task: {task}", f"Plan goal: {plan.goal or task}", "", "Results of the steps that ran:"]
    for state in states.values():
        args = ", ".join(f"{k}={v}" for k, v in (state.args or state.step.args).items())
        head = f"- {state.step.id} {state.step.tool}({args}) [{state.state}]"
        if state.state == "done":
            body = json.dumps(state.output, ensure_ascii=False, default=str)
            lines.append(f"{head}: {body[:1800]}")
        else:
            lines.append(f"{head}: {state.error or state.summary}")
    lines += [
        "",
        "Write the final answer for the user now. Use only these results for live facts. If a step failed, "
        "was skipped or wasn't approved, say briefly what is missing. If the task asks for a comparison or a "
        "recommendation, give a clear one and the reasons for it.",
    ]
    return "\n".join(lines)


def _score_city(weather: dict[str, Any] | None, air: dict[str, Any] | None) -> tuple[float, list[str]]:
    """Lower is better for an outdoor event: clean air, little rain, comfortable heat."""
    score, notes = 0.0, []
    if air and air.get("us_aqi") is not None:
        aqi = float(air["us_aqi"])
        score += aqi / 50
        notes.append(f"AQI {round(aqi)} ({str(air.get('category', '')).lower()})")
    if weather:
        now = weather.get("now") or {}
        today = (weather.get("forecast") or [{}])[0]
        if now.get("temperature") is not None:
            temp = float(now["temperature"])
            score += abs(temp - 24) / 4
            notes.append(f"{round(temp)}°")
        if today.get("rain_chance") is not None:
            score += float(today["rain_chance"]) / 25
            notes.append(f"{today['rain_chance']}% chance of rain")
    return score, notes


def fallback_answer(task: str, plan: Plan, states: dict[str, StepState]) -> str:
    """The answer without a language model: the step summaries, plus a simple
    rule-based recommendation when cities were compared."""
    done = [s for s in states.values() if s.state == "done"]
    missing = [s for s in states.values() if s.state != "done"]
    parts = [s.summary for s in done if s.summary]

    by_city: dict[str, dict[str, Any]] = {}
    for state in done:
        if state.step.tool in ("get_weather", "get_air_quality"):
            city = str(state.output.get("location") or state.args.get("city") or "").split(",")[0]
            key = "weather" if state.step.tool == "get_weather" else "air"
            by_city.setdefault(city, {})[key] = state.output
    if len(by_city) >= 2 and re.search(r"recommend|best|which|compare|better", task, re.IGNORECASE):
        ranked = sorted((( *_score_city(v.get("weather"), v.get("air")), city) for city, v in by_city.items()), key=lambda r: r[0])
        best_score, best_notes, best = ranked[0]
        others = ", ".join(city for _, _, city in ranked[1:])
        parts.append(
            f"Recommendation: {best}, which has the best mix of conditions ({', '.join(best_notes)}), ahead of {others}."
        )
    for state in missing:
        parts.append(f"I couldn't complete '{state.step.purpose}': {state.error or state.state}.")
    if not parts:
        return "I couldn't get any of the information that task needed."
    return " ".join(parts)


SYNTHESIS_NOTE = (
    "\n\nYou have just run a multi-step plan. The user's message contains the task and the result of every "
    "step. Answer the task directly from those results."
)


async def run_planned(
    *,
    provider: LLMProvider,
    system: str,
    history: list[ChatMessage],
    user_text: str,
    ctx: ToolContext,
    run_id: str,
    confirmations: Confirmations | None,
    specs: list[ToolSpec],
    memories: list[str] | None = None,
    runner: Runner = tool_registry.execute,
    sleep: Sleep = asyncio.sleep,
    step_timeout: float = STEP_TIMEOUT_SECONDS,
) -> AsyncIterator[AgentEvent]:
    """Plan, execute and answer one task. Yields AgentEvents; the last is "done".

    If no usable plan can be made, raises PlanningError so the caller can use the
    plain loop instead.
    """
    started = time.perf_counter()
    usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    yield AgentEvent("status", {"state": "planning", "label": "Planning"})

    plan, repairs = await make_plan(provider, user_text, ctx.prefs, specs, memories or [], sleep, usage)
    plan_ms = round((time.perf_counter() - started) * 1000)
    if not plan.steps:
        raise PlanningError("the plan has no steps")
    yield AgentEvent("plan", {"run_id": run_id, **plan.to_dict(), "repairs": repairs, "plan_ms": plan_ms})

    states: dict[str, StepState] = {}
    yield AgentEvent("status", {"state": "tool", "label": f"Running {len(plan.steps)} steps"})
    exec_started = time.perf_counter()
    resolve: Resolver
    if provider.name == "demo":
        async def resolve(step: PlanStep, deps: dict[str, StepState]) -> dict[str, Any]:
            return auto_fill(step, deps)
    else:
        resolve = model_resolver(provider, sleep, usage)
    async for event in execute_plan(
        plan, ctx, run_id=run_id, confirmations=confirmations, resolve=resolve, runner=runner,
        sleep=sleep, step_timeout=step_timeout, states=states,
    ):
        yield event
    execute_ms = round((time.perf_counter() - exec_started) * 1000)

    answer_started = time.perf_counter()
    yield AgentEvent("status", {"state": "answering"})
    text = ""
    if provider.name == "demo":
        text = fallback_answer(user_text, plan, states)
        for word in text.split(" "):
            yield AgentEvent("delta", {"text": word + " "})
        text = text.strip()
    else:
        messages = [*history, ChatMessage(role="user", text=results_digest(user_text, plan, states))]
        chunks: list[str] = []
        try:
            attempt = 0
            while True:
                try:
                    async for event in provider.stream(system + SYNTHESIS_NOTE, messages, [], None):
                        if isinstance(event, TextDelta):
                            chunks.append(event.text)
                            yield AgentEvent("delta", {"text": event.text})
                        elif isinstance(event, TurnEnd):
                            _add_usage(usage, event.usage)
                    break
                except LLMError as error:
                    attempt += 1
                    wait = error.retry_after if error.retry_after is not None else 1.5 * attempt
                    if chunks or not error.retryable or attempt > MAX_MODEL_RETRIES or wait > MAX_RETRY_WAIT_SECONDS:
                        raise
                    await sleep(wait)
            text = "".join(chunks).strip()
        except LLMError:
            if not chunks:  # the model can't write the answer; the results still can
                text = fallback_answer(user_text, plan, states)
                yield AgentEvent("reset", {})
                yield AgentEvent("delta", {"text": text})
        if not text:
            text = fallback_answer(user_text, plan, states)
            yield AgentEvent("delta", {"text": text})
    answer_ms = round((time.perf_counter() - answer_started) * 1000)

    runs = [
        {"name": s.step.tool, "args": s.args, "ok": s.state == "done", "panel": s.panel, "summary": s.summary,
         "duration_ms": s.duration_ms or 0, "cached": s.cached, "source": s.source}
        for s in states.values()
    ]
    yield AgentEvent(
        "done",
        {
            "text": text,
            "mode": "plan",
            "run_id": run_id,
            "steps": len(plan.steps),
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "timings": {"plan_ms": plan_ms, "execute_ms": execute_ms, "answer_ms": answer_ms},
            "tools": [{k: r[k] for k in ("name", "args", "ok", "summary", "duration_ms", "cached", "source")} for r in runs],
            "followups": suggest(runs) if provider.name != "demo" or runs else [],
            "usage": usage,
            "provider": provider.name,
            "model": provider.model,
            "trace": {"plan": plan.to_dict(), "steps": [s.record() for s in states.values()], "repairs": repairs},
        },
    )
