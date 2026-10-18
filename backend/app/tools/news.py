"""Headlines from Google News RSS feeds: no API key, many publishers per query."""
from __future__ import annotations

import re
from email.utils import parsedate_to_datetime
from typing import Any

from defusedxml import ElementTree  # safe against malicious XML, unlike the stdlib parser

from .base import Tool, ToolContext, ToolError, ToolResult, clip, get_text

FEED_URL = "https://news.google.com/rss"
_REGION = re.compile(r"^[A-Za-z]{2}$")


def parse_feed(xml_text: str, limit: int = 12) -> list[dict[str, Any]]:
    """Turn an RSS document into a list of {title, source, url, published}."""
    try:
        root = ElementTree.fromstring(xml_text)
    except Exception as exc:  # defusedxml raises several unrelated types
        raise ToolError("Google News sent a feed that couldn't be read.") from exc

    items: list[dict[str, Any]] = []
    for node in root.iter("item"):
        title = (node.findtext("title") or "").strip()
        source = (node.findtext("source") or "").strip()
        # Titles arrive as "Headline - Publisher"; the publisher is shown separately.
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3].strip()
        published = None
        raw_date = node.findtext("pubDate")
        if raw_date:
            try:
                published = parsedate_to_datetime(raw_date).isoformat()
            except (TypeError, ValueError):
                published = None
        link = (node.findtext("link") or "").strip()
        if title and link.startswith(("http://", "https://")):
            items.append(
                {"title": clip(title, 180), "source": source, "url": link, "published": published}
            )
        if len(items) >= limit:
            break
    return items


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    region = (ctx.prefs.news_region or "IN").strip()
    return {
        "topic": " ".join(str(args.get("topic") or "").split())[:120],
        "region": region.upper() if _REGION.match(region) else "IN",
    }


async def _get_news(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    topic = args.get("topic") or ""
    region = args.get("region") or "IN"
    params = {"hl": f"en-{region}", "gl": region, "ceid": f"{region}:en"}
    url = FEED_URL
    if topic:
        url = f"{FEED_URL}/search"
        params = {"q": topic, **params}

    items = parse_feed(await get_text(ctx, url, source="Google News", params=params))
    if not items:
        raise ToolError(f"No news stories were found{f' about {topic}' if topic else ''}.")

    heading = f"News about {topic}" if topic else "Top headlines"
    lead = items[0]
    summary = (
        f"{len(items)} stories{f' about {topic}' if topic else ''}. "
        f"The top one is from {lead['source'] or 'an unnamed publisher'}: {lead['title']}."
    )
    return ToolResult(
        data={
            "topic": topic or "top headlines",
            "headlines": [
                {"title": i["title"], "source": i["source"], "published": i["published"]}
                for i in items[:8]
            ],
            "summary": summary,
        },
        summary=summary,
        source="Google News",
        source_url="https://news.google.com/",
        panel={"type": "news", "title": heading, "topic": topic, "items": items},
    )


TOOLS = [
    Tool(
        name="get_news",
        description=(
            "Recent news headlines from many publishers. Use for current events and anything "
            "'latest' or 'today'. Omit topic for the top headlines."
        ),
        parameters={
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Subject to search for, e.g. 'artificial intelligence' or 'ISRO'.",
                }
            },
        },
        handler=_get_news,
        ttl_seconds=300,
        defaults=_defaults,
        status_label="Reading the news",
    )
]
