"""Wikipedia: search for the best-matching article and return its summary."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from .base import Tool, ToolContext, ToolError, ToolResult, clip, dig, get_json

SEARCH_URL = "https://en.wikipedia.org/w/api.php"
SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/"
FEATURED_URL = "https://en.wikipedia.org/api/rest_v1/feed/featured/"


def _from_summary(page: dict[str, Any], featured: bool = False) -> ToolResult:
    title = page.get("title") or dig(page, "titles", "normalized", default="Wikipedia")
    extract = " ".join(str(page.get("extract") or "").split())
    url = dig(page, "content_urls", "desktop", "page") or (
        f"https://en.wikipedia.org/wiki/{quote(str(title).replace(' ', '_'))}"
    )
    lat, lon = dig(page, "coordinates", "lat"), dig(page, "coordinates", "lon")
    points = []
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        points.append({"lat": lat, "lon": lon, "label": title, "kind": "place"})

    lead = "Today's featured article is " if featured else ""
    summary = f"{lead}{title}: {clip(extract, 280)}" if extract else f"{lead}{title}."
    return ToolResult(
        data={
            "title": title,
            "description": page.get("description") or "",
            "extract": clip(extract, 1200),
            "summary": summary,
        },
        summary=summary,
        source="Wikipedia",
        source_url=url,
        panel={
            "type": "wikipedia",
            "title": title,
            "description": page.get("description") or "",
            "extract": extract,
            "url": url,
            "thumbnail": dig(page, "thumbnail", "source"),
            "featured": featured,
            "points": points,
        },
    )


async def _summary(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    query = " ".join(str(args.get("query") or "").split())[:200]

    if not query:
        today = datetime.now(timezone.utc)
        feed = await get_json(
            ctx, f"{FEATURED_URL}{today:%Y/%m/%d}", source="Wikipedia"
        )
        article = feed.get("tfa") if isinstance(feed, dict) else None
        if not article:
            raise ToolError("Wikipedia has no featured article listed for today.")
        return _from_summary(article, featured=True)

    found = await get_json(
        ctx,
        SEARCH_URL,
        source="Wikipedia",
        params={
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": 3,
            "format": "json",
            "utf8": 1,
        },
    )
    titles = [hit.get("title") for hit in dig(found, "query", "search", default=[]) if hit.get("title")]
    if not titles:
        raise ToolError(f"Wikipedia has no article matching '{query}'.")

    # A search can land on a disambiguation page ("Mercury may refer to...");
    # skip those and take the next real article.
    fallback: dict[str, Any] | None = None
    for title in titles:
        try:
            page = await get_json(
                ctx, SUMMARY_URL + quote(title.replace(" ", "_"), safe=""), source="Wikipedia"
            )
        except ToolError as error:
            if error.status == 404:
                continue
            raise
        if not isinstance(page, dict):
            continue
        if page.get("type") == "disambiguation":
            fallback = fallback or page
            continue
        return _from_summary(page)
    if fallback:
        return _from_summary(fallback)
    raise ToolError(f"Wikipedia has no article matching '{query}'.")


TOOLS = [
    Tool(
        name="wikipedia_summary",
        description=(
            "Look up a person, place, event or concept on Wikipedia and get a summary. "
            "Use when facts should be checked or the user asks about a specific named thing. "
            "Omit query for today's featured article."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look up, e.g. 'Alan Turing'."}
            },
        },
        handler=_summary,
        ttl_seconds=3600,
        status_label="Searching Wikipedia",
    )
]
