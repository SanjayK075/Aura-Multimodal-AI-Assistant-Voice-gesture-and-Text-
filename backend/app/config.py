"""All runtime settings, read from environment variables or backend/.env.

Nothing else in the codebase reads os.environ directly, so this file is the
complete list of knobs.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- LLM -----------------------------------------------------------
    # auto = Gemini if a key is set, else Groq, else the built-in demo router.
    llm_provider: str = "auto"

    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    gemini_thinking_level: str = ""  # optional: minimal | low | medium | high
    # Only change this to route Gemini calls through a gateway or a test server.
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    groq_reasoning_effort: str = ""  # optional: low | medium | high

    # Any other OpenAI-compatible server (OpenRouter, Ollama, LM Studio, ...).
    openai_compat_base_url: str = ""
    openai_compat_api_key: str = ""
    openai_compat_model: str = ""

    llm_timeout_seconds: float = 60.0
    # Includes the model's hidden reasoning tokens, so keep some headroom.
    llm_max_output_tokens: int = 4096
    max_agent_steps: int = 5
    history_messages: int = 12

    # --- Data sources --------------------------------------------------
    github_token: str = ""  # optional; lifts GitHub from 60 to 5,000 requests/hour
    nasa_api_key: str = "DEMO_KEY"
    # Serve bundled sample responses instead of calling the real APIs.
    offline_sample_data: bool = False
    http_timeout_seconds: float = 12.0
    contact_email: str = ""  # added to the User-Agent, as Wikipedia asks

    # --- Storage, security ---------------------------------------------
    database_url: str = "sqlite:///./aura.db"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    rate_limit_per_minute: int = 20
    max_message_chars: int = 2000

    @field_validator("llm_provider", "gemini_thinking_level", "groq_reasoning_effort")
    @classmethod
    def _lower(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator(
        "gemini_api_key", "groq_api_key", "openai_compat_api_key", "github_token", "nasa_api_key"
    )
    @classmethod
    def _strip(cls, value: str) -> str:
        # A stray space or quote pasted into .env is the most common setup mistake.
        return value.strip().strip("\"'")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]

    @property
    def sqlalchemy_url(self) -> str:
        """Hosted Postgres gives postgres:// URLs; SQLAlchemy wants a driver name."""
        url = self.database_url.strip()
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix):]
        return url

    @property
    def user_agent(self) -> str:
        contact = f" ({self.contact_email})" if self.contact_email else ""
        return f"AuraAssistant/1.0{contact}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
