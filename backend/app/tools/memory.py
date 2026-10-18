"""Long-term memory: facts the person asks Aura to remember, kept per browser.

Saved facts are also added to the system prompt (see agent/prompts.py), so the
model can use them without calling a tool. Forgetting asks for confirmation.
"""
from __future__ import annotations

import asyncio
from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, clip


def _require_db(ctx: ToolContext) -> Any:
    if ctx.db is None or not ctx.client_id:
        raise ToolError("Memory isn't available here.")
    return ctx.db


def _panel(items: list[dict[str, Any]], title: str, note: str = "") -> dict[str, Any]:
    return {"type": "memory", "title": title, "items": items, "note": note}


async def _remember(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    db = _require_db(ctx)
    fact = " ".join(str(args.get("fact") or "").split())
    if len(fact) < 3:
        raise ToolError("There was nothing to remember.")
    saved = await asyncio.to_thread(db.add_memory, ctx.client_id, fact)
    items = await asyncio.to_thread(db.list_memories, ctx.client_id)
    summary = f"Saved to memory: {clip(fact, 160)}"
    return ToolResult(
        data={"saved": saved, "summary": summary},
        summary=summary,
        source="Aura memory",
        panel=_panel(items, "Memory", note=f"Saved: {clip(fact, 120)}"),
    )


async def _list(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    db = _require_db(ctx)
    query = str(args.get("query") or "")
    items = await asyncio.to_thread(db.list_memories, ctx.client_id, query, 50)
    if items:
        summary = f"{len(items)} saved fact{'s' if len(items) != 1 else ''}" + (f" matching '{query}'" if query else "") + "."
    else:
        summary = "Nothing saved" + (f" matches '{query}'" if query else " yet") + "."
    return ToolResult(
        data={"memories": [{"id": m["id"], "text": m["text"]} for m in items[:30]], "summary": summary},
        summary=summary,
        source="Aura memory",
        panel=_panel(items, "Memory"),
    )


async def _forget(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    db = _require_db(ctx)
    if args.get("all"):
        removed = await asyncio.to_thread(db.clear_memories, ctx.client_id)
        summary = f"Forgot everything: {removed} fact{'s' if removed != 1 else ''} removed."
    else:
        target: dict[str, Any] | None = None
        if args.get("memory_id"):
            matches = [m for m in await asyncio.to_thread(db.list_memories, ctx.client_id) if m["id"] == args["memory_id"]]
            target = matches[0] if matches else None
        elif args.get("query"):
            matches = await asyncio.to_thread(db.list_memories, ctx.client_id, str(args["query"]), 10)
            if len(matches) > 1:
                options = "; ".join(f"#{m['id']}: {clip(m['text'], 60)}" for m in matches[:5])
                raise ToolError(f"Several saved facts match. Say which one: {options}")
            target = matches[0] if matches else None
        else:
            raise ToolError("Say which fact to forget.")
        if target is None:
            raise ToolError("No saved fact matches that.")
        await asyncio.to_thread(db.delete_memory, ctx.client_id, target["id"])
        summary = f"Forgot: {clip(target['text'], 160)}"
    items = await asyncio.to_thread(db.list_memories, ctx.client_id)
    return ToolResult(
        data={"summary": summary}, summary=summary, source="Aura memory", panel=_panel(items, "Memory", note=summary)
    )


def _describe_forget(args: dict[str, Any]) -> str:
    """The question put to the person before anything is deleted."""
    if args.get("all"):
        return "Delete everything Aura has saved about you? Go ahead?"
    if args.get("memory_id"):
        return f"Delete saved note number {args['memory_id']}. Go ahead?"
    return f"Delete the saved note about \"{args.get('query', 'that')}\". Go ahead?"


TOOLS = [
    Tool(
        name="remember",
        description=(
            "Save a fact the user wants remembered for later, such as a date, a preference or a plan. "
            "Use when they say 'remember', 'note that' or 'don't forget'."
        ),
        parameters={
            "type": "object",
            "properties": {"fact": {"type": "string", "description": "The fact, written as a full sentence about the user."}},
            "required": ["fact"],
        },
        handler=_remember,
        status_label="Saving to memory",
        uses_network=False,
        side_effects=True,
    ),
    Tool(
        name="list_memories",
        description="List the facts the user asked to be remembered, optionally only those mentioning some words.",
        parameters={
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Only facts containing these words."}},
        },
        handler=_list,
        status_label="Checking memory",
        uses_network=False,
    ),
    Tool(
        name="forget_memory",
        description="Delete a saved fact by its id or by words it contains, or every saved fact. Asks the user first.",
        parameters={
            "type": "object",
            "properties": {
                "memory_id": {"type": "integer", "description": "The id of the fact to delete."},
                "query": {"type": "string", "description": "Words identifying the fact to delete."},
                "all": {"type": "boolean", "description": "Delete every saved fact."},
            },
        },
        handler=_forget,
        status_label="Updating memory",
        uses_network=False,
        side_effects=True,
        consequential=True,
        describe=_describe_forget,
    ),
]
