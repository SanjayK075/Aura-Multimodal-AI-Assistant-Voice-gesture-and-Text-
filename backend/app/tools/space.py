"""NASA's astronomy picture of the day."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, clip, get_json

APOD_URL = "https://api.nasa.gov/planetary/apod"
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---- NASA astronomy picture of the day ---------------------------------


async def _space_picture(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    params: dict[str, Any] = {"api_key": ctx.settings.nasa_api_key or "DEMO_KEY", "thumbs": "true"}
    date = str(args.get("date") or "").strip()
    if date:
        if not _DATE.match(date):
            raise ToolError("The date must look like 2026-01-31.")
        params["date"] = date
    try:
        apod = await get_json(ctx, APOD_URL, source="NASA", params=params)
    except ToolError as error:
        if error.retryable:
            try:
                return await _wikimedia_picture(ctx, date)
            except ToolError:
                pass  # report NASA's own error below
        if error.status == 429:
            raise ToolError(
                "NASA's shared demo key has hit its limit. A free personal key from api.nasa.gov "
                "(set NASA_API_KEY) removes it.",
                status=429,
            ) from error
        raise
    if not isinstance(apod, dict) or not apod.get("title"):
        raise ToolError("NASA sent a reply that couldn't be read.")

    is_video = apod.get("media_type") == "video"
    image = apod.get("thumbnail_url") if is_video else apod.get("url")
    explanation = " ".join(str(apod.get("explanation") or "").split())
    summary = f"NASA's picture for {apod.get('date')} is {apod['title']}. {clip(explanation, 220)}"
    return ToolResult(
        data={
            "title": apod["title"],
            "date": apod.get("date"),
            "explanation": clip(explanation, 900),
            "summary": summary,
        },
        summary=summary,
        source="NASA APOD",
        source_url="https://apod.nasa.gov/apod/astropix.html",
        panel={
            "type": "space",
            "kind": "apod",
            "title": apod["title"],
            "date": apod.get("date"),
            "explanation": explanation,
            "image": image,
            "hd_image": apod.get("hdurl") or image,
            "is_video": is_video,
            "video_url": apod.get("url") if is_video else None,
            "credit": " ".join(str(apod.get("copyright") or "").split()),
        },
    )


async def _wikimedia_picture(ctx: ToolContext, date: str) -> ToolResult:
    """Backup when NASA's API is down or rate limited: Wikimedia's picture of the day."""
    day = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    feed = await get_json(
        ctx,
        f"https://en.wikipedia.org/api/rest_v1/feed/featured/{day.replace('-', '/')}",
        source="Wikimedia",
        headers={"User-Agent": "Aura/3 (https://github.com)"},
    )
    picture = feed.get("image") if isinstance(feed, dict) else None
    if not isinstance(picture, dict):
        raise ToolError("Wikimedia had no picture for that day.")
    thumb = (picture.get("thumbnail") or {}).get("source")
    full = (picture.get("image") or {}).get("source") or thumb
    if not thumb:
        raise ToolError("Wikimedia had no picture for that day.")
    title = str(picture.get("title") or "Picture of the day").removeprefix("File:").rsplit(".", 1)[0].replace("_", " ")
    text = " ".join(str((picture.get("description") or {}).get("text") or "").split())
    summary = f"NASA's picture service is unavailable, so here is Wikimedia's picture of the day: {title}. {clip(text, 200)}"
    return ToolResult(
        data={"title": title, "date": day, "explanation": clip(text, 900), "summary": summary},
        summary=summary,
        source="Wikimedia Commons",
        source_url="https://commons.wikimedia.org/wiki/Commons:Picture_of_the_day",
        panel={
            "type": "space",
            "kind": "apod",
            "title": title,
            "date": day,
            "explanation": text or "Wikimedia Commons picture of the day. NASA's picture of the day is unavailable right now.",
            "image": thumb,
            "hd_image": full,
            "is_video": False,
            "video_url": None,
            "credit": " ".join(str((picture.get("artist") or {}).get("text") or "").split()),
        },
    )


TOOLS = [
    Tool(
        name="get_space_picture",
        description=(
            "NASA's Astronomy Picture of the Day with its explanation. "
            "Omit date for today's picture."
        ),
        parameters={
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "A past date as YYYY-MM-DD."}
            },
        },
        handler=_space_picture,
        ttl_seconds=3600,
        status_label="Asking NASA",
    ),
]
