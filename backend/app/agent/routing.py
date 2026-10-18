"""Two decisions made before the model is called.

1. Which tools to offer. Every tool schema costs tokens on every model call,
   so each question gets a small core set plus only the groups its words point
   at (and whatever the previous turn used, so follow-ups keep working).
2. Whether a request needs a plan: comparisons and "do X, then Y"
   requests go to the planner; everything else to the plain agent loop.
"""
from __future__ import annotations

import re
from typing import Iterable

from .. import tools as tool_registry
from ..llm.base import ToolSpec

CORE = ("web_search", "wikipedia_summary", "get_datetime", "remember")

GROUPS: dict[str, tuple[tuple[str, ...], str]] = {
    "weather": (
        ("get_weather", "get_air_quality"),
        r"weather|forecast|rain|umbrella|temperature|hot|cold|humid|sunny|snow|wind|storm|cloud|"
        r"\bair\b|aqi|pollution|smog|pm ?2|pm10|uv|outdoor|outside|picnic|jog|run\b|walk|trip|beach|wear",
    ),
    "github": (("github_user_repos", "github_repo_issues"), r"github|repo|repositor|issue|pull request|\bpr\b|commit|open source"),
    "news": (("get_news",), r"news|headline|latest|today|happening|current events|stories|update"),
    "space": (
        ("get_space_picture", "get_satellites"),
        r"space|nasa|apod|astronom|satellite|starlink|orbit|gps|isro|overhead|sky|space station",
    ),
    "memory": (
        ("remember", "list_memories", "forget_memory"),
        r"remember|forget|memor|note that|don'?t forget|remind|about me|saved|you know",
    ),
}

_PLAN_HINTS = re.compile(
    r"\b(compare|comparison|versus|vs\.?|recommend|which (?:city|one|place|of them|is better)|"
    r"step by step|plan (?:my|a|an|the)|"
    r"then|after that|and also|each of|all three|for each)\b",
    re.IGNORECASE,
)


def matched_groups(text: str) -> list[str]:
    lowered = text.lower()
    return [name for name, (_, pattern) in GROUPS.items() if re.search(pattern, lowered)]


def select_tools(text: str, previous_tools: Iterable[str] = (), enabled: bool = True) -> list[ToolSpec]:
    """The tools to offer for this question, in registry order."""
    available = tool_registry.ALL_TOOLS
    if not enabled:
        return tool_registry.specs()
    wanted = set(CORE)
    for group in matched_groups(text):
        wanted.update(GROUPS[group][0])
    previous = set(previous_tools)
    for names, _ in GROUPS.values():
        if previous & set(names):  # a follow-up to a weather answer keeps the weather tools
            wanted.update(names)
    return [ToolSpec(t.name, t.description, t.parameters) for t in available if t.name in wanted]


def needs_plan(text: str) -> bool:
    """True for requests that are clearly several tasks in one."""
    if _PLAN_HINTS.search(text):
        return True
    groups = matched_groups(text)
    return len(groups) >= 2 and bool(re.search(r"\band\b|,", text))
