"""Provider-neutral types shared by the agent loop and every LLM provider.

The agent loop only ever sees these types. Each provider translates them to
and from its own wire format, which is what makes providers swappable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol


@dataclass
class ToolSpec:
    """A tool as advertised to the model: name, description, JSON-schema parameters."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ToolCall:
    """The model asking us to run a tool."""

    id: str
    name: str
    args: dict[str, Any]
    # The id the provider itself assigned, if any (Gemini 2.5 assigns none).
    native_id: str | None = None


@dataclass
class ToolOutput:
    """What we send back to the model after running a tool."""

    call: ToolCall
    content: dict[str, Any]


@dataclass
class ChatMessage:
    role: str  # "user" | "assistant" | "tool"
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_outputs: list[ToolOutput] = field(default_factory=list)
    # The assistant turn exactly as the provider returned it. Sending it back
    # unchanged preserves provider-specific fields (Gemini thought signatures).
    raw: Any = None
    raw_provider: str | None = None


@dataclass
class TextDelta:
    text: str


@dataclass
class TurnEnd:
    """Final event of one model call: the complete assistant message."""

    message: ChatMessage
    usage: dict[str, int] = field(default_factory=dict)


LLMEvent = TextDelta | TurnEnd


class LLMError(Exception):
    """A provider failure, already translated into something a user can act on.

    kind: auth | rate_limit | model | bad_request | blocked | server | network
    """

    RETRYABLE = {"rate_limit", "server", "network"}

    def __init__(
        self,
        message: str,
        kind: str = "server",
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.kind in self.RETRYABLE


class LLMProvider(Protocol):
    name: str
    model: str

    def stream(
        self,
        system: str,
        messages: list[ChatMessage],
        tools: list[ToolSpec],
        context: dict[str, Any] | None = None,
    ) -> AsyncIterator[LLMEvent]:
        """Yield TextDelta events as text arrives, then exactly one TurnEnd."""
        ...


def kind_for_status(status: int) -> str:
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "model"
    if status == 429:
        return "rate_limit"
    if status >= 500:
        return "server"
    return "bad_request"


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None
