"""The tool registry: every tool the agent can call, and the one way to run them.

Adding a tool means writing one module with a TOOLS list and adding it to
_MODULES below. Nothing else in the backend needs to change.
"""
from __future__ import annotations

import json
import logging
from dataclasses import replace
from typing import Any

from ..llm.base import ToolSpec
from . import clock, github, news, space, weather, wikipedia
from .base import Tool, ToolContext, ToolError, ToolResult, TTLCache, UserPrefs

log = logging.getLogger("aura.tools")

_MODULES = (weather, github, news, wikipedia, space, clock)
ALL_TOOLS: list[Tool] = [tool for module in _MODULES for tool in module.TOOLS]
REGISTRY: dict[str, Tool] = {tool.name: tool for tool in ALL_TOOLS}
CACHE = TTLCache()


def specs() -> list[ToolSpec]:
    """Tool definitions in the form handed to the model."""
    return [ToolSpec(t.name, t.description, t.parameters) for t in ALL_TOOLS]


def clean_args(tool: Tool, raw: Any) -> dict[str, Any]:
    """Keep only declared parameters and coerce them to the declared types.

    Models occasionally send "3" for an integer or invent extra keys; tolerating
    that here is cheaper than a failed tool call and a second model round trip.
    """
    if not isinstance(raw, dict):
        return {}
    cleaned: dict[str, Any] = {}
    for name, schema in (tool.parameters.get("properties") or {}).items():
        value = raw.get(name)
        if value is None:
            continue
        kind = schema.get("type")
        try:
            if kind == "integer":
                value = int(float(value))
            elif kind == "string":
                value = str(value).strip()
                if not value:
                    continue
            elif kind == "boolean":
                value = str(value).lower() in ("true", "1", "yes") if not isinstance(value, bool) else value
        except (TypeError, ValueError):
            continue
        cleaned[name] = value
    return cleaned


async def execute(
    name: str, raw_args: Any, ctx: ToolContext, cache: TTLCache | None = None
) -> tuple[ToolResult, dict[str, Any]]:
    """Run a tool by name. Returns the result and the arguments actually used.

    Raises ToolError with a user-safe message on any failure. If a call fails
    but an older result for the same arguments is still in memory, that older
    result is returned instead, which keeps the UI useful through rate limits.
    """
    cache = CACHE if cache is None else cache
    tool = REGISTRY.get(name)
    if tool is None:
        raise ToolError(f"There is no tool called '{name}'.")

    args = clean_args(tool, raw_args)
    if tool.defaults:
        try:
            args = tool.defaults(ctx, args)
        except (TypeError, ValueError) as exc:
            raise ToolError(f"The arguments for {name} weren't valid.") from exc

    offline = ctx.settings.offline_sample_data
    key = f"{name}|{json.dumps(args, sort_keys=True, default=str)}|{offline}"
    if tool.ttl_seconds:
        hit = cache.get(key)
        if hit is not None:
            return replace(hit, cached=True), args

    try:
        result = await tool.handler(ctx, args)
    except ToolError:
        stale = cache.get(key, allow_stale=True) if tool.ttl_seconds else None
        if stale is not None:
            return replace(stale, cached=True), args
        raise
    except Exception as exc:  # a bug in a tool must not take the whole request down
        log.exception("tool %s crashed", name)
        raise ToolError(f"Something went wrong inside the {name} tool.") from exc

    if offline and tool.uses_network:
        result = replace(result, source=f"{result.source} (sample data)")
    if tool.ttl_seconds:
        cache.set(key, result, tool.ttl_seconds)
    return result, args


__all__ = [
    "ALL_TOOLS",
    "CACHE",
    "REGISTRY",
    "Tool",
    "ToolContext",
    "ToolError",
    "ToolResult",
    "TTLCache",
    "UserPrefs",
    "clean_args",
    "execute",
    "specs",
]
