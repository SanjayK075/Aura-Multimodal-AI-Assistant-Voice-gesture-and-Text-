"""Web search. Uses Tavily when TAVILY_API_KEY is set (free tier: 1,000 searches a
month); otherwise combines three key-free sources: DuckDuckGo's instant answers,
a Google News search for anything recent, and Wikipedia's search."""
from __future__ import annotations

import asyncio
import re
from html import unescape
from typing import Any
from urllib.parse import quote

from .base import Tool, ToolContext, ToolError, ToolResult, clip, get_json, get_text, post_json
from .news import parse_feed

TAVILY_URL = "https://api.tavily.com/search"
DDG_URL = "https://api.duckduckgo.com/"
NEWS_SEARCH_URL = "https://news.google.com/rss/search"
WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php"


def _plain(text: Any) -> str:
    """Wikipedia and DuckDuckGo send HTML: drop tags and decode entities like &quot; and &#039;."""
    return " ".join(unescape(re.sub(r"<[^>]+>", "", str(text or ""))).split())


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    return {
        "query": " ".join(str(args.get("query") or "").split())[:200],
        "max_results": max(3, min(10, int(args.get("max_results") or 6))),
    }


async def _tavily(ctx: ToolContext, query: str, limit: int) -> tuple[str | None, list[dict[str, Any]]]:
    reply = await post_json(
        ctx,
        TAVILY_URL,
        source="Tavily",
        body={"query": query, "max_results": limit, "search_depth": "basic", "include_answer": True},
        headers={"Authorization": f"Bearer {ctx.settings.tavily_api_key}"},
    )
    results = [
        {
            "title": clip(r.get("title"), 160),
            "url": r.get("url"),
            "snippet": clip(r.get("content"), 320),
            "source": "Web",
            "published": r.get("published_date"),
        }
        for r in reply.get("results") or []
        if r.get("url")
    ]
    return (clip(reply.get("answer"), 600) or None), results


async def _duckduckgo(ctx: ToolContext, query: str) -> tuple[str | None, list[dict[str, Any]]]:
    reply = await get_json(
        ctx,
        DDG_URL,
        source="DuckDuckGo",
        params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1, "t": "aura"},
    )
    answer = reply.get("Answer") or reply.get("AbstractText") or None
    results = []
    if reply.get("AbstractURL") and reply.get("AbstractText"):
        results.append(
            {
                "title": reply.get("Heading") or query,
                "url": reply["AbstractURL"],
                "snippet": clip(_plain(reply["AbstractText"]), 320),
                "source": reply.get("AbstractSource") or "DuckDuckGo",
                "published": None,
            }
        )
    topics: list[dict[str, Any]] = []
    for topic in reply.get("RelatedTopics") or []:
        topics.extend(topic.get("Topics") or [topic])
    for topic in topics[:4]:
        if topic.get("FirstURL") and topic.get("Text"):
            results.append(
                {
                    "title": clip(topic["Text"].split(" - ")[0], 120),
                    "url": topic["FirstURL"],
                    "snippet": clip(_plain(topic["Text"]), 240),
                    "source": "DuckDuckGo",
                    "published": None,
                }
            )
    return (clip(answer, 600) if answer else None), results


async def _news(ctx: ToolContext, query: str) -> list[dict[str, Any]]:
    region = (ctx.prefs.news_region or "IN").upper()
    xml = await get_text(
        ctx,
        NEWS_SEARCH_URL,
        source="Google News",
        params={"q": query, "hl": f"en-{region}", "gl": region, "ceid": f"{region}:en"},
    )
    return [
        {"title": i["title"], "url": i["url"], "snippet": "", "source": i["source"] or "News", "published": i["published"]}
        for i in parse_feed(xml, limit=5)
    ]


async def _wikipedia(ctx: ToolContext, query: str) -> list[dict[str, Any]]:
    reply = await get_json(
        ctx,
        WIKI_SEARCH_URL,
        source="Wikipedia",
        params={"action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": 3},
    )
    out = []
    for hit in (reply.get("query") or {}).get("search") or []:
        title = str(hit.get("title") or "")
        if not title:
            continue
        snippet = _plain(hit.get("snippet"))
        out.append(
            {
                "title": title,
                "url": "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_")),
                "snippet": clip(snippet, 240),
                "source": "Wikipedia",
                "published": None,
            }
        )
    return out


async def _web_search(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    query, limit = args.get("query") or "", args["max_results"]
    if not query:
        raise ToolError("Nothing to search for. Give a search query.")

    if ctx.settings.tavily_api_key:
        answer, results = await _tavily(ctx, query, limit)
        engine, source_url = "Tavily", "https://tavily.com/"
    else:
        # Three independent sources at once; one failing doesn't sink the search.
        gathered = await asyncio.gather(
            _duckduckgo(ctx, query), _news(ctx, query), _wikipedia(ctx, query), return_exceptions=True
        )
        ddg, news, wiki = gathered
        answer = ddg[0] if isinstance(ddg, tuple) else None
        results = []
        for part in (ddg[1] if isinstance(ddg, tuple) else [], wiki if isinstance(wiki, list) else [], news if isinstance(news, list) else []):
            results.extend(part)
        if all(isinstance(g, BaseException) for g in gathered):
            raise ToolError("None of the search sources could be reached.", retryable=True)
        engine, source_url = "DuckDuckGo, Google News, Wikipedia", "https://duckduckgo.com/"

    seen: set[str] = set()
    unique = [r for r in results if r["url"] and not (r["url"] in seen or seen.add(r["url"]))][:limit]
    if not unique and not answer:
        raise ToolError(f"The search for '{query}' found nothing.")

    lead = f" Short answer: {answer}" if answer else ""
    top = f" Top result: {unique[0]['title']} ({unique[0]['source']})." if unique else ""
    summary = f"Searched the web for '{query}': {len(unique)} results.{lead}{top}"
    return ToolResult(
        data={
            "query": query,
            "answer": answer,
            "results": [{k: r[k] for k in ("title", "snippet", "source", "published", "url")} for r in unique],
            "summary": clip(summary, 700),
        },
        summary=clip(summary, 700),
        source=engine,
        source_url=source_url,
        panel={"type": "search", "title": f"Search: {clip(query, 60)}", "query": query, "answer": answer, "engine": engine, "items": unique},
    )


TOOLS = [
    Tool(
        name="web_search",
        description=(
            "Search the web for anything recent or specific that the other tools don't cover: events, "
            "product releases, people in the news, scores, prices. Returns titles, snippets and links."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for, as a search engine query."},
                "max_results": {"type": "integer", "description": "How many results, 3 to 10. Defaults to 6."},
            },
            "required": ["query"],
        },
        handler=_web_search,
        ttl_seconds=600,
        defaults=_defaults,
        status_label="Searching the web",
    )
]
