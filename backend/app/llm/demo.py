"""A keyword router that stands in for an LLM when no API key is configured.

It lets the whole app run end to end with zero setup: it picks a tool from
keywords in the question, then reads the tool's summary back. It cannot answer
general questions; the reply says so and points at the .env file.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any, AsyncIterator

from .base import ChatMessage, LLMEvent, TextDelta, ToolCall, ToolSpec, TurnEnd

NO_KEY_REPLY = (
    "I'm running in demo mode without a language model, so I can only fetch live data: "
    "weather, GitHub, news, Wikipedia and space. Add a free Gemini or Groq key to "
    "backend/.env and I can answer anything."
)

_PLACE = re.compile(
    r"\b(?:in|for|at|of)\s+([A-Za-z][A-Za-z .'-]{1,40}?)"
    r"(?=\s+(?:today|tomorrow|tonight|this|next|on|right|now|over|for|and)\b|[?.!,]|$)",
    re.IGNORECASE,
)
_REPO = re.compile(r"\b([\w.-]+/[\w.-]+)\b")
_USER = re.compile(r"(?:@|\buser(?:name)?\s+|\b(?:of|by|for)\s+)([A-Za-z0-9][A-Za-z0-9-]{0,38})\b")
_WIKI_LEAD = re.compile(
    r"^(?:please\s+)?(?:search\s+wikipedia\s+for|look\s+up|wikipedia|who\s+(?:is|was|were|are)|"
    r"what\s+(?:is|was|are|were)|tell\s+me\s+about|define|explain)\s+",
    re.IGNORECASE,
)
_NEWS_NOISE = re.compile(
    r"\b(?:show|me|the|top|latest|today'?s?|what'?s|whats|new|news|headlines?|stories|give|get|"
    r"any|some|recent|happening|is|are|in|on|about|regarding)\b",
    re.IGNORECASE,
)
_POSSESSIVE = re.compile(r"\b([A-Za-z0-9][A-Za-z0-9-]{0,38})'s\b")
_STOP_USERS = {"my", "me", "the", "a", "an", "this", "that", "github", "repos", "issues", "today", "what", "it", "nasa"}


def route(text: str, context: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Pick a tool and arguments for a question, or None if nothing matches."""
    lowered = text.lower().replace("-", " ")

    def has(*words: str) -> bool:
        # Whole words only (plus a plural), so "issues" doesn't match "iss".
        return any(re.search(rf"\b{re.escape(w)}(?:e?s)?\b", lowered) for w in words)

    if has("weather", "forecast", "rain", "raining", "temperature", "hot", "cold", "sunny", "humid"):
        args: dict[str, Any] = {}
        place = _PLACE.search(text)
        if place:
            args["city"] = place.group(1).strip()
        if has("week", "weekend", "7 day", "seven"):
            args["days"] = 7
        return "get_weather", args
    if has("iss", "space station"):
        return "get_iss_position", {}
    if has("launch", "launching", "rocket"):
        return "get_upcoming_launches", {}
    if has("nasa", "apod", "picture of the day", "astronomy", "space"):
        return "get_space_picture", {}
    if has("github", "repo", "repository", "repositories", "issue", "pull request"):
        repo = _REPO.search(text)
        if repo and has("issue"):
            args = {"repo": repo.group(1)}
            if has("closed"):
                args["state"] = "closed"
            return "github_repo_issues", args
        user = _POSSESSIVE.search(text) or _USER.search(text)
        args = {}
        if user and user.group(1).lower() not in _STOP_USERS:
            args["username"] = user.group(1)
        if has("star", "popular"):
            args["sort"] = "stars"
        return "github_user_repos", args
    if has("news", "headline"):
        topic = " ".join(_NEWS_NOISE.sub(" ", text).replace("?", " ").split())
        return "get_news", ({"topic": topic} if topic else {})
    if has("time", "date", "day is it", "what day"):
        return "get_datetime", {}
    if has("wikipedia", "who is", "who was", "what is", "what are", "tell me about", "define"):
        if has("featured"):
            return "wikipedia_summary", {}
        query = _WIKI_LEAD.sub("", text.strip()).strip(" ?.!")
        query = re.sub(r"^(?:an?|the)\s+", "", query, flags=re.IGNORECASE)
        return "wikipedia_summary", ({"query": query} if query else {})
    return None


class DemoProvider:
    name = "demo"
    model = "keyword-router"

    def __init__(self, word_delay: float = 0.02) -> None:
        self.word_delay = word_delay

    async def stream(
        self,
        system: str,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        context: dict[str, Any] | None = None,
    ) -> AsyncIterator[LLMEvent]:
        context = context or {}
        last = messages[-1] if messages else None
        available = {tool.name for tool in tools}

        if last is not None and last.role == "tool":
            parts = []
            for output in last.tool_outputs:
                if output.content.get("error"):
                    parts.append(f"That didn't work: {output.content['error']}")
                else:
                    parts.append(str(output.content.get("summary") or "Done."))
            reply = " ".join(parts)
        else:
            question = last.text if last is not None else ""
            choice = route(question, context)
            if choice and choice[0] in available:
                name, args = choice
                yield TurnEnd(
                    ChatMessage(
                        role="assistant",
                        tool_calls=[ToolCall(id="demo_1", name=name, args=args)],
                        raw_provider=self.name,
                    )
                )
                return
            reply = NO_KEY_REPLY

        words = reply.split(" ")
        for index, word in enumerate(words):
            if self.word_delay:
                await asyncio.sleep(self.word_delay)
            yield TextDelta(word + (" " if index < len(words) - 1 else ""))
        yield TurnEnd(ChatMessage(role="assistant", text=reply, raw_provider=self.name))
