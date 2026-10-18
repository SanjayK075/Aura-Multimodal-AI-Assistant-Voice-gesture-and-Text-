"""Shared fixtures. No test touches the network: every HTTP call is answered
by a fake transport, either the bundled sample data or a handler the test supplies."""
from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

from app import offline
from app.config import Settings
from app.tools.base import ToolContext, TTLCache, UserPrefs


def make_settings(**overrides: Any) -> Settings:
    """Settings that ignore the developer's real .env and environment keys."""
    values: dict[str, Any] = dict(
        llm_provider="demo",
        gemini_api_key="",
        groq_api_key="",
        github_token="",
        nasa_api_key="DEMO_KEY",
        openai_compat_base_url="",
        openai_compat_model="",
        database_url="sqlite://",
        offline_sample_data=True,
        rate_limit_per_minute=1000,
        contact_email="",
    )
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def cache() -> TTLCache:
    return TTLCache()


def make_ctx(
    handler: Callable[[httpx.Request], httpx.Response] | None = None,
    settings: Settings | None = None,
    **prefs: Any,
) -> ToolContext:
    transport = httpx.MockTransport(handler) if handler else offline.transport()
    return ToolContext(
        http=httpx.AsyncClient(transport=transport),
        settings=settings or make_settings(),
        prefs=UserPrefs(**prefs),
    )


@pytest.fixture
def ctx() -> ToolContext:
    return make_ctx(default_city="Chennai", github_username="octocat", timezone="Asia/Kolkata")


def sse_body(*chunks: Any, done: bool = False) -> bytes:
    """Encode JSON chunks the way a streaming LLM API sends them."""
    lines = [f"data: {json.dumps(c)}\n\n" for c in chunks]
    if done:
        lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def sse_response(*chunks: Any, done: bool = False) -> httpx.Response:
    return httpx.Response(
        200, content=sse_body(*chunks, done=done), headers={"content-type": "text/event-stream"}
    )


def parse_sse(text: str) -> list[tuple[str, dict[str, Any]]]:
    """Decode a server-sent-event stream into (event, data) pairs."""
    events = []
    for block in text.strip().split("\n\n"):
        name, data = "message", "{}"
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        events.append((name, json.loads(data)))
    return events
