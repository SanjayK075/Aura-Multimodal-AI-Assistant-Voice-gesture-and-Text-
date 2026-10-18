"""The HTTP API. Run with:  uvicorn app.main:app --reload

Routes
  GET    /api/health               liveness check (also used to wake a sleeping free host)
  GET    /api/config               which model is active, which tools exist
  POST   /api/chat                 ask a question; the reply streams back as server-sent events
  GET    /api/conversations        this browser's past conversations
  GET    /api/conversations/{id}   one conversation with its messages and panels
  DELETE /api/conversations/{id}   delete one
  DELETE /api/conversations        delete everything stored for this browser
  GET    /api/activity             log of every tool call the agent made
  GET    /api/space/iss            live ISS position for the globe
"""
from __future__ import annotations

import json
import logging
import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import __version__, offline
from . import tools as tool_registry
from .agent import build_system_prompt, run_agent
from .config import Settings, get_settings
from .db import Database
from .llm import build_provider
from .llm.base import ChatMessage, LLMError, LLMProvider
from .ratelimit import RateLimiter
from .schemas import ChatRequest
from .tools.base import ToolContext, ToolError, UserPrefs

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# httpx logs full request URLs at INFO, and some of those carry an API key.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("aura")
_CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def sse(event: str, data: dict[str, Any]) -> str:
    """Format one server-sent event."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def history_to_messages(rows: list[dict[str, Any]]) -> list[ChatMessage]:
    """Turn stored messages into model context.

    Past tool calls are replayed as a short note, not as real tool messages:
    it is far fewer tokens, and it works no matter which provider wrote them.
    """
    messages: list[ChatMessage] = []
    for row in rows:
        text = row["content"]
        if row["role"] == "assistant":
            notes = [
                f"{t['name']}({json.dumps(t.get('args') or {}, ensure_ascii=False)}) -> {t.get('summary', '')}"
                for t in (row.get("meta") or {}).get("tools") or []
            ]
            if notes:
                text += "\n(Context, not shown to the user. Tools used: " + "; ".join(notes) + ")"
        if text:
            messages.append(ChatMessage(role=row["role"], text=text))
    return messages


def create_app(
    settings: Settings | None = None,
    provider: LLMProvider | None = None,
    data_client: httpx.AsyncClient | None = None,
    database: Database | None = None,
) -> FastAPI:
    """Build the app. The optional arguments let tests swap in fakes."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned: list[httpx.AsyncClient] = []

        http = data_client
        if http is None:
            http = httpx.AsyncClient(
                timeout=settings.http_timeout_seconds,
                headers={"User-Agent": settings.user_agent},
                follow_redirects=True,
                transport=offline.transport() if settings.offline_sample_data else None,
            )
            owned.append(http)

        llm = provider
        if llm is None:
            llm_client = httpx.AsyncClient(
                timeout=httpx.Timeout(settings.llm_timeout_seconds, connect=10.0)
            )
            owned.append(llm_client)
            llm = build_provider(settings, llm_client)

        app.state.settings = settings
        app.state.http = http
        app.state.provider = llm
        app.state.db = database or Database(settings.sqlalchemy_url)
        app.state.chat_limiter = RateLimiter(settings.rate_limit_per_minute)
        log.info("LLM provider: %s (%s)", llm.name, llm.model)
        try:
            yield
        finally:
            for client in owned:
                await client.aclose()
            if database is None:
                app.state.db.close()

    app = FastAPI(title="Aura API", version=__version__, lifespan=lifespan)

    origins = settings.cors_origin_list
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if "*" in origins else origins,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Client-Id"],
    )

    # ---- helpers ----------------------------------------------------------

    def client_id(request: Request) -> str:
        """Identify the browser. There are no accounts: the frontend generates a
        random id once and sends it with every request."""
        supplied = request.headers.get("x-client-id", "")
        if _CLIENT_ID.match(supplied):
            return supplied
        host = request.client.host if request.client else "unknown"
        return f"ip-{host}"[:64]

    def tool_context(request: Request, prefs: UserPrefs | None = None) -> ToolContext:
        return ToolContext(http=request.app.state.http, settings=settings, prefs=prefs or UserPrefs())

    # ---- routes -----------------------------------------------------------

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"name": "Aura API", "version": __version__, "docs": "/docs", "health": "/api/health"}

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/config")
    async def config(request: Request) -> dict[str, Any]:
        llm: LLMProvider = request.app.state.provider
        return {
            "version": __version__,
            "provider": llm.name,
            "model": llm.model,
            "demo": llm.name == "demo",
            "sample_data": settings.offline_sample_data,
            "max_message_chars": settings.max_message_chars,
            "tools": [
                {"name": t.name, "description": t.description} for t in tool_registry.ALL_TOOLS
            ],
        }

    @app.post("/api/chat")
    async def chat(body: ChatRequest, request: Request) -> StreamingResponse:
        cid = client_id(request)
        if len(body.message) > settings.max_message_chars:
            raise HTTPException(
                413, f"That message is too long. The limit is {settings.max_message_chars} characters."
            )
        wait = request.app.state.chat_limiter.check(cid)
        if wait:
            raise HTTPException(
                429,
                f"Too many requests. Try again in {int(wait) + 1} seconds.",
                headers={"Retry-After": str(int(wait) + 1)},
            )

        db: Database = request.app.state.db
        llm: LLMProvider = request.app.state.provider
        prefs = UserPrefs(**body.prefs.model_dump())
        ctx = tool_context(request, prefs)

        conversation_id = await run_in_threadpool(
            db.ensure_conversation, cid, body.conversation_id, body.message[:80]
        )
        rows = await run_in_threadpool(db.recent_messages, conversation_id, settings.history_messages)
        history = history_to_messages(rows)
        await run_in_threadpool(db.add_message, conversation_id, "user", body.message)

        async def stream() -> AsyncIterator[str]:
            yield sse("meta", {"conversation_id": conversation_id, "provider": llm.name, "model": llm.model})
            panels: list[dict[str, Any]] = []
            try:
                async for event in run_agent(
                    provider=llm,
                    system=build_system_prompt(prefs),
                    history=history,
                    user_text=body.message,
                    ctx=ctx,
                    max_steps=settings.max_agent_steps,
                ):
                    data = event.data
                    if event.type == "tool":
                        if data.get("panel"):
                            panels.append(
                                {
                                    **data["panel"],
                                    "source": data.get("source"),
                                    "source_url": data.get("source_url"),
                                }
                            )
                        await run_in_threadpool(
                            db.log_tool_call,
                            client_id=cid,
                            conversation_id=conversation_id,
                            name=data["name"],
                            args=data.get("args") or {},
                            ok=bool(data.get("ok")),
                            summary=data.get("summary") or "",
                            source=data.get("source") or "",
                            duration_ms=int(data.get("duration_ms") or 0),
                            cached=bool(data.get("cached")),
                        )
                    elif event.type == "done":
                        message_id = await run_in_threadpool(
                            db.add_message,
                            conversation_id,
                            "assistant",
                            data["text"],
                            panels,
                            {
                                "provider": data["provider"],
                                "model": data["model"],
                                "latency_ms": data["latency_ms"],
                                "steps": data["steps"],
                                "usage": data["usage"],
                                "followups": data["followups"],
                                "tools": [
                                    {"name": t["name"], "args": t["args"], "summary": t["summary"]}
                                    for t in data["tools"]
                                ],
                            },
                        )
                        data = {**data, "message_id": message_id, "conversation_id": conversation_id}
                    yield sse(event.type, data)
            except LLMError as error:
                log.warning("LLM error (%s): %s", error.kind, error.message)
                yield sse(
                    "error",
                    {"message": error.message, "kind": error.kind, "retry_after": error.retry_after},
                )
            except Exception:  # never leave the client hanging on an open stream
                log.exception("chat stream failed")
                yield sse(
                    "error",
                    {"message": "Something went wrong on the server. Try again.", "kind": "server"},
                )

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/conversations")
    async def list_conversations(request: Request) -> dict[str, Any]:
        db: Database = request.app.state.db
        return {"conversations": await run_in_threadpool(db.list_conversations, client_id(request))}

    @app.get("/api/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str, request: Request) -> dict[str, Any]:
        db: Database = request.app.state.db
        found = await run_in_threadpool(db.get_conversation, client_id(request), conversation_id)
        if found is None:
            raise HTTPException(404, "That conversation doesn't exist.")
        return found

    @app.delete("/api/conversations/{conversation_id}")
    async def delete_conversation(conversation_id: str, request: Request) -> dict[str, bool]:
        db: Database = request.app.state.db
        deleted = await run_in_threadpool(db.delete_conversation, client_id(request), conversation_id)
        if not deleted:
            raise HTTPException(404, "That conversation doesn't exist.")
        return {"deleted": True}

    @app.delete("/api/conversations")
    async def clear_conversations(request: Request) -> dict[str, int]:
        db: Database = request.app.state.db
        return {"deleted": await run_in_threadpool(db.clear_client, client_id(request))}

    @app.get("/api/activity")
    async def activity(request: Request, limit: int = 100) -> dict[str, Any]:
        db: Database = request.app.state.db
        limit = max(1, min(500, limit))
        return {"activity": await run_in_threadpool(db.activity, client_id(request), limit)}

    @app.get("/api/space/iss")
    async def iss(request: Request) -> JSONResponse:
        # Goes through the tool registry so it shares the 5-second cache: many
        # browsers polling still means one upstream request every 5 seconds.
        try:
            result, _ = await tool_registry.execute("get_iss_position", {}, tool_context(request))
        except ToolError as error:
            raise HTTPException(503, error.message) from error
        return JSONResponse(result.panel["position"] if result.panel else {})

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        # One error shape for the frontend: {"message": "..."}
        return JSONResponse(
            {"message": str(exc.detail)}, status_code=exc.status_code, headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"message": "The request wasn't in the expected format."}, status_code=422)

    return app


app = create_app()
