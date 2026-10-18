"""Chooses and builds the LLM provider from settings."""
from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator, Callable

import httpx

from ..config import Settings
from .base import ChatMessage, LLMError, LLMEvent, LLMProvider, ToolSpec
from .demo import DemoProvider
from .gemini import GeminiProvider
from .openai_compat import GROQ_BASE_URL, OpenAICompatProvider

log = logging.getLogger("aura.llm")

# Failures where trying a different provider can help. A blocked or malformed
# request would fail the same way anywhere.
_FALLBACK_KINDS = {"rate_limit", "server", "network", "auth", "model"}


class FallbackProvider:
    """Tries providers in order, moving on when one is rate limited or down.

    Free tiers run out mid-demo; with both a Gemini and a Groq key configured
    the assistant keeps answering. It only switches before any text has been
    streamed, so the user never sees half an answer from each.

    A provider that just failed is rested for a while (a simple circuit
    breaker): the following requests go straight to the next one instead of
    paying for a doomed call first. It is tried again once its rest is over.
    """

    DEFAULT_REST_SECONDS = 30.0

    def __init__(
        self, providers: list[LLMProvider], clock: Callable[[], float] = time.monotonic
    ) -> None:
        if not providers:
            raise ValueError("FallbackProvider needs at least one provider")
        self.providers = providers
        self.active = providers[0]
        self._clock = clock
        self._resting_until: dict[str, float] = {}

    def _order(self) -> list[LLMProvider]:
        """Healthy providers first, in their configured order; resting ones as a last resort."""
        now = self._clock()
        rested = [p for p in self.providers if self._resting_until.get(p.name, 0) <= now]
        resting = [p for p in self.providers if p not in rested]
        return rested + resting

    @property
    def name(self) -> str:
        return self.active.name

    @property
    def model(self) -> str:
        return self.active.model

    async def stream(
        self,
        system: str,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        context: dict[str, Any] | None = None,
        tool_choice: str | None = None,
    ) -> AsyncIterator[LLMEvent]:
        order = self._order()
        failures: list[tuple[str, LLMError]] = []
        for index, provider in enumerate(order):
            emitted = False
            try:
                async for event in provider.stream(system, messages, tools, context, tool_choice):
                    emitted = True
                    self.active = provider
                    yield event
                return
            except LLMError as error:
                log.warning("LLM provider %s failed (%s, status %s): %s", provider.name, error.kind, error.status, error)
                failures.append((provider.name, error))
                if error.kind in _FALLBACK_KINDS:
                    rest = error.retry_after if error.retry_after else self.DEFAULT_REST_SECONDS
                    self._resting_until[provider.name] = self._clock() + rest
                is_last = index == len(order) - 1
                if emitted or is_last or error.kind not in _FALLBACK_KINDS:
                    if len(failures) > 1 and not emitted:
                        # Say what every provider said, not just the last one tried.
                        detail = " ".join(f"[{name}] {err}" for name, err in failures)
                        raise LLMError(detail, kind=error.kind, status=error.status, retry_after=error.retry_after) from error
                    raise


def _gemini(settings: Settings, client: httpx.AsyncClient) -> GeminiProvider:
    return GeminiProvider(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        client=client,
        max_output_tokens=settings.llm_max_output_tokens,
        thinking_level=settings.gemini_thinking_level,
        base_url=settings.gemini_base_url,
    )


def _groq(settings: Settings, client: httpx.AsyncClient) -> OpenAICompatProvider:
    extra: dict[str, Any] = {"max_completion_tokens": settings.llm_max_output_tokens}
    if settings.groq_reasoning_effort:
        extra["reasoning_effort"] = settings.groq_reasoning_effort
    return OpenAICompatProvider(
        name="groq",
        base_url=GROQ_BASE_URL,
        api_key=settings.groq_api_key,
        model=settings.groq_model,
        client=client,
        extra_body=extra,
        label="Groq",
        env_prefix="GROQ",
    )


def _openai_compat(settings: Settings, client: httpx.AsyncClient) -> OpenAICompatProvider:
    return OpenAICompatProvider(
        name="openai_compat",
        base_url=settings.openai_compat_base_url,
        api_key=settings.openai_compat_api_key,
        model=settings.openai_compat_model,
        client=client,
        extra_body={"max_tokens": settings.llm_max_output_tokens},
        label="The model server",
        env_prefix="OPENAI_COMPAT",
    )


def _keys(value: str) -> list[str]:
    """GEMINI_API_KEY may hold several keys separated by commas, each from its own
    Google account, so each has its own free quota."""
    return [k.strip() for k in (value or "").split(",") if k.strip()]


def _per_key(settings: Settings, client: httpx.AsyncClient, field: str, make) -> list[LLMProvider]:
    return [make(settings.model_copy(update={field: key}), client) for key in _keys(getattr(settings, field))]


def build_provider(settings: Settings, client: httpx.AsyncClient) -> LLMProvider:
    """Return the provider named by LLM_PROVIDER.

    auto: every provider that has a key, Gemini first, each falling back to the
    next. With no keys at all, the demo router.
    """
    choice = settings.llm_provider or "auto"

    if choice == "demo":
        return DemoProvider()
    if choice == "gemini":
        if not settings.gemini_api_key:
            raise ValueError("LLM_PROVIDER=gemini but GEMINI_API_KEY is empty in backend/.env")
        found = _per_key(settings, client, "gemini_api_key", _gemini)
        return found[0] if len(found) == 1 else FallbackProvider(found)
    if choice == "groq":
        if not settings.groq_api_key:
            raise ValueError("LLM_PROVIDER=groq but GROQ_API_KEY is empty in backend/.env")
        found = _per_key(settings, client, "groq_api_key", _groq)
        return found[0] if len(found) == 1 else FallbackProvider(found)
    if choice == "openai_compat":
        if not (settings.openai_compat_base_url and settings.openai_compat_model):
            raise ValueError(
                "LLM_PROVIDER=openai_compat needs OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL"
            )
        return _openai_compat(settings, client)
    if choice != "auto":
        raise ValueError(
            f"Unknown LLM_PROVIDER '{choice}'. Use auto, gemini, groq, openai_compat or demo."
        )

    available: list[LLMProvider] = []
    available.extend(_per_key(settings, client, "gemini_api_key", _gemini))
    available.extend(_per_key(settings, client, "groq_api_key", _groq))
    if settings.openai_compat_base_url and settings.openai_compat_model:
        available.append(_openai_compat(settings, client))
    if not available:
        return DemoProvider()
    if len(available) == 1:
        return available[0]
    return FallbackProvider(available)


__all__ = [
    "ChatMessage",
    "DemoProvider",
    "FallbackProvider",
    "GeminiProvider",
    "LLMError",
    "LLMProvider",
    "OpenAICompatProvider",
    "ToolSpec",
    "build_provider",
]
