"""Building blocks every tool shares: the Tool type, results, errors, HTTP, caching."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from ..config import Settings


@dataclass
class UserPrefs:
    """Per-user defaults sent by the browser with each request."""

    default_city: str = ""
    github_username: str = ""
    news_region: str = "IN"
    units: str = "metric"  # metric | imperial
    timezone: str = "UTC"


@dataclass
class ToolContext:
    http: httpx.AsyncClient
    settings: Settings
    prefs: UserPrefs = field(default_factory=UserPrefs)


@dataclass
class ToolResult:
    # Compact facts for the model to reason over. Kept small to save tokens.
    data: dict[str, Any]
    # One or two plain sentences: used in logs and as a fallback answer.
    summary: str
    source: str
    source_url: str | None = None
    # Everything the frontend needs to draw a panel; None means "no panel".
    panel: dict[str, Any] | None = None
    cached: bool = False


class ToolError(Exception):
    """A tool failure with a message that is safe to show to the user and the model."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


Handler = Callable[[ToolContext, dict[str, Any]], Awaitable[ToolResult]]
Defaults = Callable[[ToolContext, dict[str, Any]], dict[str, Any]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema, type "object"
    handler: Handler
    ttl_seconds: float = 0.0  # how long a result may be reused; 0 disables caching
    defaults: Defaults | None = None  # fills in arguments from user preferences
    status_label: str = "Working"  # shown in the UI while the tool runs
    uses_network: bool = True


async def get_json(
    ctx: ToolContext,
    url: str,
    *,
    source: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    """GET a JSON document, turning every failure into a ToolError."""
    response = await _get(ctx, url, source=source, params=params, headers=headers)
    try:
        return response.json()
    except ValueError as exc:
        raise ToolError(f"{source} sent a reply that couldn't be read.") from exc


async def get_text(
    ctx: ToolContext,
    url: str,
    *,
    source: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> str:
    response = await _get(ctx, url, source=source, params=params, headers=headers)
    return response.text


async def _get(
    ctx: ToolContext,
    url: str,
    *,
    source: str,
    params: dict[str, Any] | None,
    headers: dict[str, str] | None,
) -> httpx.Response:
    try:
        response = await ctx.http.get(url, params=params, headers=headers)
    except httpx.TimeoutException as exc:
        raise ToolError(f"{source} took too long to respond.") from exc
    except httpx.HTTPError as exc:
        raise ToolError(f"Couldn't reach {source}.") from exc
    status = response.status_code
    if status == 404:
        raise ToolError(f"{source} has nothing at that address.", status=404)
    if status == 429 or (status == 403 and response.headers.get("x-ratelimit-remaining") == "0"):
        raise ToolError(f"{source} is rate limiting requests. Try again in a while.", status=429)
    if status >= 400:
        raise ToolError(f"{source} returned an error (HTTP {status}).", status=status)
    return response


class TTLCache:
    """A small in-memory cache that can also serve stale entries after a failure."""

    def __init__(self, max_entries: int = 256, clock: Callable[[], float] = time.monotonic) -> None:
        self._data: dict[str, tuple[float, Any]] = {}
        self._max = max_entries
        self._clock = clock

    def get(self, key: str, allow_stale: bool = False) -> Any | None:
        entry = self._data.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if allow_stale or self._clock() < expires_at:
            return value
        return None

    def set(self, key: str, value: Any, ttl: float) -> None:
        if len(self._data) >= self._max and key not in self._data:
            oldest = min(self._data, key=lambda k: self._data[k][0])
            del self._data[oldest]
        self._data[key] = (self._clock() + ttl, value)

    def clear(self) -> None:
        self._data.clear()


def dig(obj: Any, *path: str | int, default: Any = None) -> Any:
    """Safely walk nested dicts/lists: dig(d, "a", 0, "b") never raises."""
    current = obj
    for key in path:
        if isinstance(key, int):
            if not isinstance(current, list) or not -len(current) <= key < len(current):
                return default
            current = current[key]
        else:
            if not isinstance(current, dict) or key not in current:
                return default
            current = current[key]
    return default if current is None else current


def clip(text: Any, limit: int) -> str:
    """Trim text to a limit on a word boundary, adding an ellipsis."""
    value = " ".join(str(text or "").split())
    if len(value) <= limit:
        return value
    cut = value[:limit].rsplit(" ", 1)[0].rstrip(",;:.")
    return cut + "…"
