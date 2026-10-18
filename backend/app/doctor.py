"""Checks the setup and says exactly what is wrong.

    python -m app.doctor

It tests each configured LLM with a real tool-calling round trip, then calls
every data source once. Run it after editing .env, or whenever something
stops working.
"""
from __future__ import annotations

import asyncio
import sys

import httpx

from . import offline
from . import tools as tool_registry
from .config import get_settings
from .llm import _gemini, _groq, _openai_compat
from .llm.base import ChatMessage, LLMError, TextDelta, ToolOutput, TurnEnd
from .tools.base import ToolContext, ToolError, TTLCache, UserPrefs

OK, FAIL, SKIP = "[ OK ]", "[FAIL]", "[SKIP]"

_SAMPLE_CALLS = [
    ("get_weather", {"city": "Chennai"}),
    ("github_user_repos", {"username": "torvalds"}),
    ("github_repo_issues", {"repo": "fastapi/fastapi"}),
    ("get_news", {"topic": "technology"}),
    ("wikipedia_summary", {"query": "Alan Turing"}),
    ("get_space_picture", {}),
    ("get_upcoming_launches", {"limit": 3}),
    ("get_iss_position", {}),
    ("get_datetime", {"timezone": "Asia/Kolkata"}),
]


async def check_provider(provider) -> bool:
    """One full tool-calling exchange: question -> tool call -> tool result -> answer."""
    label = f"{provider.name} ({provider.model})"
    weather = [s for s in tool_registry.specs() if s.name == "get_weather"]
    system = "You are a test assistant. Always use the get_weather tool for weather questions."
    messages = [ChatMessage(role="user", text="What is the weather in Chennai right now?")]
    try:
        turn = None
        async for event in provider.stream(system, messages, weather):
            if isinstance(event, TurnEnd):
                turn = event.message
        if turn is None or not turn.tool_calls:
            print(f"{FAIL} {label}: replied but did not call the tool. Reply: {turn.text[:120] if turn else ''!r}")
            return False
        call = turn.tool_calls[0]
        messages += [
            turn,
            ChatMessage(
                role="tool",
                tool_outputs=[
                    ToolOutput(call, {"location": "Chennai, India", "now": {"temperature": 31, "description": "Partly cloudy"}})
                ],
            ),
        ]
        answer = ""
        async for event in provider.stream(system, messages, weather):
            if isinstance(event, TextDelta):
                answer += event.text
        if not answer.strip():
            print(f"{FAIL} {label}: called the tool but gave no final answer.")
            return False
        print(f"{OK} {label}: tool call {call.name}({call.args}) then answered: {answer.strip()[:90]!r}")
        return True
    except LLMError as error:
        print(f"{FAIL} {label}: {error.message}")
        if error.kind == "model":
            try:
                models = await provider.list_models()
                print("       Models this key can use:")
                for name in models[:40]:
                    print(f"         {name}")
            except LLMError as inner:
                print(f"       (Couldn't list models: {inner.message})")
        return False


async def main() -> int:
    settings = get_settings()
    print("Aura setup check")
    print("================")
    print(f"LLM_PROVIDER        = {settings.llm_provider}")
    print(f"GEMINI_API_KEY      = {'set' if settings.gemini_api_key else 'not set'}   model: {settings.gemini_model}")
    print(f"GROQ_API_KEY        = {'set' if settings.groq_api_key else 'not set'}   model: {settings.groq_model}")
    print(f"GITHUB_TOKEN        = {'set' if settings.github_token else 'not set (60 requests/hour)'}")
    print(f"NASA_API_KEY        = {'shared DEMO_KEY (30 requests/hour)' if settings.nasa_api_key == 'DEMO_KEY' else 'set'}")
    print(f"OFFLINE_SAMPLE_DATA = {settings.offline_sample_data}")
    print(f"DATABASE_URL        = {settings.sqlalchemy_url.split('@')[-1]}")
    print()

    failures = 0
    print("Language models")
    print("---------------")
    async with httpx.AsyncClient(timeout=httpx.Timeout(settings.llm_timeout_seconds, connect=10.0)) as client:
        checked = False
        if settings.gemini_api_key:
            checked = True
            failures += not await check_provider(_gemini(settings, client))
        if settings.groq_api_key:
            checked = True
            failures += not await check_provider(_groq(settings, client))
        if settings.openai_compat_base_url and settings.openai_compat_model:
            checked = True
            failures += not await check_provider(_openai_compat(settings, client))
        if not checked:
            print(f"{SKIP} No API key set. The app will run in demo mode (live data only).")
            print("       Add GEMINI_API_KEY or GROQ_API_KEY to backend/.env to ask anything.")
    print()

    print("Data sources")
    print("------------")
    async with httpx.AsyncClient(
        timeout=settings.http_timeout_seconds,
        headers={"User-Agent": settings.user_agent},
        follow_redirects=True,
        transport=offline.transport() if settings.offline_sample_data else None,
    ) as http:
        ctx = ToolContext(http=http, settings=settings, prefs=UserPrefs(timezone="UTC"))
        for name, args in _SAMPLE_CALLS:
            try:
                result, _ = await tool_registry.execute(name, args, ctx, cache=TTLCache())
                print(f"{OK} {name:<22} {result.source}: {result.summary[:80]}")
            except ToolError as error:
                failures += 1
                print(f"{FAIL} {name:<22} {error.message}")
    print()
    print("All good." if not failures else f"{failures} check(s) failed. See the messages above.")
    return 1 if failures else 0


if __name__ == "__main__":
    # Windows consoles default to a legacy code page; don't crash on a degree sign.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    sys.exit(asyncio.run(main()))
