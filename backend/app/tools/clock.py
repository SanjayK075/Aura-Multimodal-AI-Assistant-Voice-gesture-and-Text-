"""Date and time. Models don't know what day it is, so this is a tool like any other."""
from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .base import Tool, ToolContext, ToolError, ToolResult


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    return {"timezone": str(args.get("timezone") or ctx.prefs.timezone or "UTC").strip()}


async def _get_datetime(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    name = args.get("timezone") or "UTC"
    try:
        zone = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError) as exc:
        raise ToolError(
            f"'{name}' isn't a known timezone. Use an IANA name such as 'Asia/Kolkata'."
        ) from exc
    now = datetime.now(zone)
    hour = now.hour % 12 or 12
    spoken_time = f"{hour}:{now:%M} {'AM' if now.hour < 12 else 'PM'}"
    spoken_date = f"{now:%A}, {now.day} {now:%B %Y}"
    summary = f"It's {spoken_time} on {spoken_date} in {name}."
    return ToolResult(
        data={
            "iso": now.isoformat(timespec="seconds"),
            "date": spoken_date,
            "time": spoken_time,
            "timezone": name,
            "summary": summary,
        },
        summary=summary,
        source="System clock",
    )


TOOLS = [
    Tool(
        name="get_datetime",
        description=(
            "The current date and time. Omit timezone for the user's own. "
            "Use for 'what time is it', 'what's today's date', or time in another place."
        ),
        parameters={
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "description": "IANA timezone name, e.g. 'Asia/Kolkata' or 'America/New_York'.",
                }
            },
        },
        handler=_get_datetime,
        defaults=_defaults,
        status_label="Checking the time",
        uses_network=False,
    )
]
