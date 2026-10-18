"""The agent loop: ask the model, run the tools it asks for, repeat until it answers.

    user question
         |
         v
    +-> model call --(text only)--> final answer
    |       |
    |   (tool calls)
    |       v
    +-- run tools, append results

The loop knows nothing about HTTP, databases or any particular LLM. It takes a
provider and a tool runner and yields plain events, which is what makes it easy
to test with a scripted fake provider.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from .. import tools as tool_registry
from ..llm.base import (
    ChatMessage,
    LLMError,
    LLMEvent,
    LLMProvider,
    TextDelta,
    ToolCall,
    ToolOutput,
    ToolSpec,
    TurnEnd,
)
from ..tools.base import ToolContext, ToolError, ToolResult
from .followups import suggest

MAX_MODEL_RETRIES = 2
MAX_RETRY_WAIT_SECONDS = 8.0

ToolRunner = Callable[[str, Any, ToolContext], Awaitable[tuple[ToolResult, dict[str, Any]]]]


@dataclass
class AgentEvent:
    """One step of progress. type: status | delta | reset | tool | done"""

    type: str
    data: dict[str, Any] = field(default_factory=dict)


async def _model_turn(
    provider: LLMProvider,
    system: str,
    messages: list[ChatMessage],
    tools: list[ToolSpec],
    context: dict[str, Any],
    sleep: Callable[[float], Awaitable[None]],
) -> AsyncIterator[LLMEvent]:
    """One model call, retried on rate limits and outages.

    A retry is only safe while nothing has been streamed to the user, and only
    worth it when the wait is short; otherwise the error is raised.
    """
    attempt = 0
    while True:
        emitted = False
        try:
            async for event in provider.stream(system, messages, tools, context):
                emitted = emitted or isinstance(event, TextDelta)
                yield event
            return
        except LLMError as error:
            attempt += 1
            wait = error.retry_after if error.retry_after is not None else 1.5 * attempt
            if (
                emitted
                or not error.retryable
                or attempt > MAX_MODEL_RETRIES
                or wait > MAX_RETRY_WAIT_SECONDS
            ):
                raise
            await sleep(wait)


async def _run_tool(
    call: ToolCall, ctx: ToolContext, runner: ToolRunner
) -> dict[str, Any]:
    """Run one tool call and describe the outcome. Never raises."""
    started = time.perf_counter()
    label = getattr(tool_registry.REGISTRY.get(call.name), "status_label", "Working")
    record: dict[str, Any] = {
        "id": call.id,
        "name": call.name,
        "label": label,
        "args": call.args,
        "ok": False,
        "summary": "",
        "error": None,
        "cached": False,
        "source": None,
        "source_url": None,
        "panel": None,
        "output": {},
    }
    try:
        result, used_args = await runner(call.name, call.args, ctx)
        record.update(
            ok=True,
            args=used_args,
            summary=result.summary,
            cached=result.cached,
            source=result.source,
            source_url=result.source_url,
            panel=result.panel,
            output=result.data,
        )
    except ToolError as error:
        record.update(error=error.message, summary=error.message, output={"error": error.message})
    record["duration_ms"] = round((time.perf_counter() - started) * 1000)
    return record


async def run_agent(
    *,
    provider: LLMProvider,
    system: str,
    history: list[ChatMessage],
    user_text: str,
    ctx: ToolContext,
    tool_specs: list[ToolSpec] | None = None,
    max_steps: int = 5,
    runner: ToolRunner = tool_registry.execute,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> AsyncIterator[AgentEvent]:
    """Answer one user message. Yields AgentEvents; the last is always "done".

    Raises LLMError if the model can't be reached after retries.
    """
    started = time.perf_counter()
    specs = tool_registry.specs() if tool_specs is None else tool_specs
    messages = [*history, ChatMessage(role="user", text=user_text)]
    context = {
        "default_city": ctx.prefs.default_city,
        "github_username": ctx.prefs.github_username,
    }
    tool_runs: list[dict[str, Any]] = []
    usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    final_text = ""
    steps = 0

    while True:
        steps += 1
        # On the last allowed step the model gets no tools, which forces it to
        # answer with what it has instead of looping forever.
        offered = specs if steps <= max_steps else []
        yield AgentEvent("status", {"state": "thinking"})

        turn: ChatMessage | None = None
        streamed = False
        async for event in _model_turn(provider, system, messages, offered, context, sleep):
            if isinstance(event, TextDelta):
                if not streamed:
                    streamed = True
                    yield AgentEvent("status", {"state": "answering"})
                yield AgentEvent("delta", {"text": event.text})
            elif isinstance(event, TurnEnd):
                turn = event.message
                for key in usage:
                    usage[key] += int(event.usage.get(key) or 0)
        if turn is None:
            raise LLMError("The model ended its reply unexpectedly.", kind="server")
        messages.append(turn)

        if not turn.tool_calls or not offered:
            final_text = turn.text.strip()
            break

        # Text that came before a tool call ("Let me check...") is not the
        # answer; tell the client to discard it.
        if streamed:
            yield AgentEvent("reset", {})

        first_label = getattr(
            tool_registry.REGISTRY.get(turn.tool_calls[0].name), "status_label", "Working"
        )
        yield AgentEvent(
            "status", {"state": "tool", "tool": turn.tool_calls[0].name, "label": first_label}
        )
        records = await asyncio.gather(*(_run_tool(call, ctx, runner) for call in turn.tool_calls))
        outputs = []
        for call, record in zip(turn.tool_calls, records):
            tool_runs.append(record)
            outputs.append(ToolOutput(call=call, content=record["output"]))
            yield AgentEvent("tool", {k: v for k, v in record.items() if k != "output"})
        messages.append(ChatMessage(role="tool", tool_outputs=outputs))

    if not final_text:
        # The model returned nothing after its tools ran. Fall back to the
        # tools' own summaries so the user still gets an answer.
        final_text = " ".join(run["summary"] for run in tool_runs if run["summary"]) or (
            "I couldn't come up with an answer to that. Try asking another way."
        )
        yield AgentEvent("delta", {"text": final_text})

    yield AgentEvent(
        "done",
        {
            "text": final_text,
            "steps": steps,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "tools": [
                {k: run[k] for k in ("name", "args", "ok", "summary", "duration_ms", "cached", "source")}
                for run in tool_runs
            ],
            # The demo router can't answer open follow-ups, so offer none.
            "followups": suggest(tool_runs) if (tool_runs or provider.name != "demo") else [],
            "usage": usage,
            "provider": provider.name,
            "model": provider.model,
        },
    )
