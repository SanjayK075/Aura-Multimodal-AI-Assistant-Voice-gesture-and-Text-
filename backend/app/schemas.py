"""Shapes of the JSON bodies the API accepts."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Prefs(BaseModel):
    default_city: str = Field(default="", max_length=80)
    github_username: str = Field(default="", max_length=40)
    news_region: str = Field(default="IN", max_length=2)
    units: str = Field(default="metric", max_length=10)
    timezone: str = Field(default="UTC", max_length=64)

    @field_validator("default_city", "github_username", "news_region", "units", "timezone")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    conversation_id: str | None = Field(default=None, max_length=36)
    prefs: Prefs = Field(default_factory=Prefs)
    mode: Literal["auto", "plan", "single"] = "auto"


    @field_validator("message")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message must not be blank")
        return value


class ConfirmRequest(BaseModel):
    step_id: str = Field(min_length=1, max_length=80)
    approved: bool


class MemoryIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
