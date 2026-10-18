"""The HTTP API end to end: real routes, real database, real tools on sample data."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.llm.base import ChatMessage, LLMError, TextDelta, TurnEnd
from app.main import create_app, history_to_messages, sse
from app.ratelimit import RateLimiter
from app.tools.base import TTLCache

from .conftest import make_settings, parse_sse

ME = {"X-Client-Id": "browser-aaaa-1111"}
OTHER = {"X-Client-Id": "browser-bbbb-2222"}


@pytest.fixture
def client():
    with TestClient(create_app(make_settings())) as test_client:
        yield test_client


def ask(client, message, headers=ME, **extra):
    response = client.post("/api/chat", json={"message": message, **extra}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    return parse_sse(response.text)


def last(events, name):
    return [data for event, data in events if event == name][-1]


def test_health_config_and_root(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    config = client.get("/api/config").json()
    assert config["provider"] == "demo" and config["demo"] is True and config["sample_data"] is True
    assert len(config["tools"]) == 9
    assert client.get("/").json()["docs"] == "/docs"


def test_chat_streams_a_tool_backed_answer(client):
    events = ask(client, "What's the weather in Chennai?", prefs={"units": "metric", "timezone": "Asia/Kolkata"})
    names = [event for event, _ in events]
    assert names[0] == "meta" and names[-1] == "done"
    assert names.index("tool") < names.index("delta")

    meta, tool, done = events[0][1], last(events, "tool"), last(events, "done")
    assert meta["provider"] == "demo" and len(meta["conversation_id"]) == 36
    assert tool["name"] == "get_weather" and tool["panel"]["location"]["name"] == "Chennai"
    assert done["text"].startswith("Chennai, India:")
    assert done["conversation_id"] == meta["conversation_id"] and done["message_id"] > 0
    streamed = "".join(data["text"] for event, data in events if event == "delta")
    assert streamed == done["text"]


def test_conversation_is_stored_with_panels_and_can_be_continued(client):
    first = ask(client, "weather in Tokyo")
    conversation_id = last(first, "done")["conversation_id"]
    second = ask(client, "where is the ISS", conversation_id=conversation_id)
    assert last(second, "done")["conversation_id"] == conversation_id

    listing = client.get("/api/conversations", headers=ME).json()["conversations"]
    assert [c["title"] for c in listing] == ["weather in Tokyo"]

    stored = client.get(f"/api/conversations/{conversation_id}", headers=ME).json()
    assert [m["role"] for m in stored["messages"]] == ["user", "assistant", "user", "assistant"]
    reply = stored["messages"][1]
    assert reply["panels"][0]["type"] == "weather"
    assert reply["panels"][0]["source"] == "Open-Meteo (sample data)"
    assert reply["meta"]["tools"][0]["name"] == "get_weather"
    assert reply["meta"]["followups"] and reply["meta"]["latency_ms"] >= 0
    assert stored["messages"][3]["panels"][0]["kind"] == "iss"


def test_each_browser_sees_only_its_own_data(client):
    conversation_id = last(ask(client, "top headlines"), "done")["conversation_id"]

    assert client.get("/api/conversations", headers=OTHER).json()["conversations"] == []
    assert client.get(f"/api/conversations/{conversation_id}", headers=OTHER).status_code == 404
    assert client.delete(f"/api/conversations/{conversation_id}", headers=OTHER).status_code == 404
    assert client.get("/api/activity", headers=OTHER).json()["activity"] == []

    # Someone else's conversation id starts a fresh conversation instead of joining theirs.
    hijack = ask(client, "what time is it", headers=OTHER, conversation_id=conversation_id)
    assert last(hijack, "done")["conversation_id"] != conversation_id
    assert len(client.get(f"/api/conversations/{conversation_id}", headers=ME).json()["messages"]) == 2


def test_activity_log_records_every_tool_call(client):
    ask(client, "weather in Paris")
    ask(client, "weather in Atlantis")  # fails: unknown city
    activity = client.get("/api/activity", headers=ME).json()["activity"]
    assert [(a["name"], a["ok"]) for a in activity] == [("get_weather", False), ("get_weather", True)]  # newest first
    assert activity[1]["args"]["city"] == "Paris" and activity[1]["source"].startswith("Open-Meteo")
    assert "Atlantis" in activity[0]["summary"]
    assert client.get("/api/activity?limit=1", headers=ME).json()["activity"][0]["ok"] is False


def test_delete_one_and_clear_all(client):
    first = last(ask(client, "top headlines"), "done")["conversation_id"]
    ask(client, "upcoming launches")
    assert client.delete(f"/api/conversations/{first}", headers=ME).json() == {"deleted": True}
    assert len(client.get("/api/conversations", headers=ME).json()["conversations"]) == 1
    assert len(client.get("/api/activity", headers=ME).json()["activity"]) == 1  # its log went with it

    assert client.delete("/api/conversations", headers=ME).json() == {"deleted": 1}
    assert client.get("/api/conversations", headers=ME).json()["conversations"] == []
    assert client.get("/api/activity", headers=ME).json()["activity"] == []


def test_bad_requests_get_a_plain_message(client):
    assert client.post("/api/chat", json={"message": "   "}, headers=ME).status_code == 422
    assert client.post("/api/chat", json={}, headers=ME).json() == {"message": "The request wasn't in the expected format."}
    too_long = client.post("/api/chat", json={"message": "x" * 2001}, headers=ME)
    assert too_long.status_code == 413 and "2000 characters" in too_long.json()["message"]
    assert client.get("/api/conversations/nope", headers=ME).json() == {"message": "That conversation doesn't exist."}


def test_chat_is_rate_limited_per_browser():
    with TestClient(create_app(make_settings(rate_limit_per_minute=2))) as client:
        for _ in range(2):
            assert client.post("/api/chat", json={"message": "top headlines"}, headers=ME).status_code == 200
        blocked = client.post("/api/chat", json={"message": "top headlines"}, headers=ME)
        assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) >= 1
        assert "Too many requests" in blocked.json()["message"]
        assert client.post("/api/chat", json={"message": "top headlines"}, headers=OTHER).status_code == 200


def test_iss_endpoint(client):
    position = client.get("/api/space/iss").json()
    assert -52 <= position["lat"] <= 52 and -180 <= position["lon"] <= 180
    assert position["altitude_km"] == 419.4


def test_cors_allows_only_configured_origins():
    settings = make_settings(cors_origins="https://aura.example.com/, http://localhost:5173")
    with TestClient(create_app(settings)) as client:
        allowed = client.options(
            "/api/chat",
            headers={"Origin": "https://aura.example.com", "Access-Control-Request-Method": "POST",
                     "Access-Control-Request-Headers": "content-type,x-client-id"},
        )
        assert allowed.headers["access-control-allow-origin"] == "https://aura.example.com"
        denied = client.options(
            "/api/chat", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
        )
        assert "access-control-allow-origin" not in denied.headers


class Failing:
    name, model = "fake", "fake-1"

    def __init__(self, error):
        self.error = error

    async def stream(self, system, messages, tools, context=None):
        raise self.error
        yield  # pragma: no cover - makes this an async generator


def test_model_failure_arrives_as_an_error_event_not_a_broken_stream():
    error = LLMError("Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env.", kind="auth")
    with TestClient(create_app(make_settings(), provider=Failing(error))) as client:
        events = ask(client, "hello")
        assert events[-1] == ("error", {"message": error.message, "kind": "auth", "retry_after": None})
        # The question is kept, so the user can see what they asked.
        conversation_id = events[0][1]["conversation_id"]
        stored = client.get(f"/api/conversations/{conversation_id}", headers=ME).json()
        assert [m["role"] for m in stored["messages"]] == ["user"]


def test_unexpected_crash_is_reported_without_leaking_details():
    with TestClient(create_app(make_settings(), provider=Failing(RuntimeError("stack trace secrets")))) as client:
        events = ask(client, "hello")
        assert events[-1][0] == "error" and "secrets" not in events[-1][1]["message"]


class Echo:
    """Replies with what it was sent, so tests can inspect the model's context."""

    name, model = "fake", "fake-1"

    async def stream(self, system, messages, tools, context=None):
        text = " | ".join(f"{m.role}:{m.text}" for m in messages)
        yield TextDelta(text)
        yield TurnEnd(ChatMessage("assistant", text=text))


def test_history_is_replayed_and_trimmed():
    settings = make_settings(history_messages=2)
    with TestClient(create_app(settings, provider=Echo())) as client:
        first = last(ask(client, "one"), "done")
        assert first["text"] == "user:one"
        second = last(ask(client, "two", conversation_id=first["conversation_id"]), "done")
        assert second["text"] == "user:one | assistant:user:one | user:two"
        third = last(ask(client, "three", conversation_id=first["conversation_id"]), "done")
        assert third["text"].startswith("user:two | assistant:") and third["text"].endswith("| user:three")


def test_history_notes_past_tool_use_compactly():
    rows = [
        {"role": "user", "content": "weather?", "meta": {}},
        {"role": "assistant", "content": "Warm.", "meta": {"tools": [
            {"name": "get_weather", "args": {"city": "Chennai"}, "summary": "Chennai: 31°C."}]}},
        {"role": "assistant", "content": "", "meta": {}},
    ]
    messages = history_to_messages(rows)
    assert len(messages) == 2  # the empty message is dropped
    assert messages[1].text.startswith("Warm.\n(Context, not shown to the user.")
    assert 'get_weather({"city": "Chennai"}) -> Chennai: 31°C.' in messages[1].text


def test_sse_format():
    assert sse("delta", {"text": "héllo\nworld"}) == 'event: delta\ndata: {"text": "héllo\\nworld"}\n\n'


# ---- pieces underneath the API ----------------------------------------------


def test_rate_limiter_window_slides():
    now = [0.0]
    limiter = RateLimiter(2, window_seconds=60, clock=lambda: now[0])
    assert limiter.check("a") == 0 and limiter.check("a") == 0
    assert limiter.check("a") == pytest.approx(60)
    assert limiter.check("b") == 0  # separate keys, separate budgets
    now[0] = 59
    assert limiter.check("a") == pytest.approx(1)
    now[0] = 61
    assert limiter.check("a") == 0
    assert RateLimiter(0).check("a") == 0  # zero disables limiting


def test_ttl_cache_expiry_staleness_and_eviction():
    now = [0.0]
    cache = TTLCache(max_entries=2, clock=lambda: now[0])
    cache.set("a", 1, ttl=10)
    assert cache.get("a") == 1
    now[0] = 11
    assert cache.get("a") is None and cache.get("a", allow_stale=True) == 1
    cache.set("b", 2, ttl=10)
    cache.set("c", 3, ttl=10)  # over capacity: the entry expiring soonest goes
    assert cache.get("a", allow_stale=True) is None and cache.get("c") == 3


def test_database_url_and_origin_normalisation():
    assert make_settings(database_url="postgres://u:p@host/db").sqlalchemy_url == "postgresql+psycopg://u:p@host/db"
    assert make_settings(database_url="postgresql://u:p@host/db?sslmode=require").sqlalchemy_url == (
        "postgresql+psycopg://u:p@host/db?sslmode=require"
    )
    assert make_settings(database_url="sqlite:///./aura.db").sqlalchemy_url == "sqlite:///./aura.db"
    assert make_settings(cors_origins=" https://a.com/ ,, http://b.com").cors_origin_list == ["https://a.com", "http://b.com"]
    assert make_settings(gemini_api_key='  "abc"  ').gemini_api_key == "abc"
    assert make_settings(contact_email="me@example.com").user_agent == "AuraAssistant/1.0 (me@example.com)"


def test_database_survives_on_disk(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    db = Database(url)
    conversation_id = db.ensure_conversation("client-1", None, "hello " * 40)
    db.add_message(conversation_id, "user", "hello", meta={"a": 1})
    db.close()

    reopened = Database(url)
    stored = reopened.get_conversation("client-1", conversation_id)
    assert len(stored["title"]) <= 120 and stored["messages"][0]["meta"] == {"a": 1}
    assert stored["messages"][0]["created_at"].endswith("+00:00")
    assert reopened.ensure_conversation("client-1", conversation_id, "x") == conversation_id
    reopened.close()
