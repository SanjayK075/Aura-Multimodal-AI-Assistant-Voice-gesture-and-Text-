"""Storage: conversations, messages, a log of every tool call, the facts a
person asked Aura to remember, and the traces of multi-step agent runs.

SQLAlchemy keeps this identical on SQLite (local file, zero setup) and
Postgres (in the cloud); only DATABASE_URL changes.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, create_engine, delete, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker
from sqlalchemy.pool import StaticPool


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:  # SQLite drops the timezone; everything is stored as UTC
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(120), default="New conversation")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="Message.id"
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="")
    panels: Mapped[list[Any]] = mapped_column(JSON, default=list)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class ToolCallLog(Base):
    __tablename__ = "tool_calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    conversation_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(64))
    args: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(80), default="")
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    cached: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class MemoryNote(Base):
    """One fact the person asked Aura to remember, e.g. "my exam is on the 20th"."""

    __tablename__ = "memories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AgentRun(Base):
    """The full trace of one planned, multi-step run: plan, every step, timings, answer."""

    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    conversation_id: Mapped[str] = mapped_column(String(36), default="")
    task: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="running")  # running | done | error
    plan: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    steps: Mapped[list[Any]] = mapped_column(JSON, default=list)
    answer: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class Database:
    """Every query the app makes. All methods are synchronous and short;
    async routes call them through a thread pool."""

    def __init__(self, url: str) -> None:
        kwargs: dict[str, Any] = {}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
            if url in ("sqlite://", "sqlite:///:memory:"):
                kwargs["poolclass"] = StaticPool  # one shared connection keeps the in-memory DB alive
        else:
            kwargs["pool_pre_ping"] = True  # hosted Postgres drops idle connections
        self.engine = create_engine(url, **kwargs)
        self._session = sessionmaker(self.engine, expire_on_commit=False)
        Base.metadata.create_all(self.engine)

    # ---- conversations ----------------------------------------------------

    def ensure_conversation(self, client_id: str, conversation_id: str | None, title: str) -> str:
        """Return an existing conversation's id if it belongs to this client, else create one."""
        with self._session() as session:
            if conversation_id:
                existing = session.get(Conversation, conversation_id)
                if existing is not None and existing.client_id == client_id:
                    return existing.id
            conversation = Conversation(
                id=str(uuid.uuid4()), client_id=client_id, title=title[:120] or "New conversation"
            )
            session.add(conversation)
            session.commit()
            return conversation.id

    def list_conversations(self, client_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._session() as session:
            rows = session.scalars(
                select(Conversation)
                .where(Conversation.client_id == client_id)
                .order_by(Conversation.updated_at.desc())
                .limit(limit)
            ).all()
            return [
                {"id": c.id, "title": c.title, "created_at": _iso(c.created_at), "updated_at": _iso(c.updated_at)}
                for c in rows
            ]

    def get_conversation(self, client_id: str, conversation_id: str) -> dict[str, Any] | None:
        with self._session() as session:
            conversation = session.get(Conversation, conversation_id)
            if conversation is None or conversation.client_id != client_id:
                return None
            return {
                "id": conversation.id,
                "title": conversation.title,
                "created_at": _iso(conversation.created_at),
                "updated_at": _iso(conversation.updated_at),
                "messages": [self._message_dict(m) for m in conversation.messages],
            }

    def delete_conversation(self, client_id: str, conversation_id: str) -> bool:
        with self._session() as session:
            conversation = session.get(Conversation, conversation_id)
            if conversation is None or conversation.client_id != client_id:
                return False
            session.delete(conversation)
            session.execute(delete(ToolCallLog).where(ToolCallLog.conversation_id == conversation_id))
            session.commit()
            return True

    def clear_client(self, client_id: str) -> int:
        """Delete everything stored for one browser. Returns conversations removed."""
        with self._session() as session:
            conversations = session.scalars(
                select(Conversation).where(Conversation.client_id == client_id)
            ).all()
            for conversation in conversations:
                session.delete(conversation)
            session.execute(delete(ToolCallLog).where(ToolCallLog.client_id == client_id))
            session.execute(delete(MemoryNote).where(MemoryNote.client_id == client_id))
            session.execute(delete(AgentRun).where(AgentRun.client_id == client_id))
            session.commit()
            return len(conversations)

    # ---- messages ---------------------------------------------------------

    @staticmethod
    def _message_dict(message: Message) -> dict[str, Any]:
        return {
            "id": message.id,
            "role": message.role,
            "content": message.content,
            "panels": message.panels or [],
            "meta": message.meta or {},
            "created_at": _iso(message.created_at),
        }

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        panels: list[Any] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> int:
        with self._session() as session:
            message = Message(
                conversation_id=conversation_id,
                role=role,
                content=content,
                panels=panels or [],
                meta=meta or {},
            )
            session.add(message)
            conversation = session.get(Conversation, conversation_id)
            if conversation is not None:
                conversation.updated_at = _now()
            session.commit()
            return message.id

    def recent_messages(self, conversation_id: str, limit: int) -> list[dict[str, Any]]:
        """The last `limit` messages, oldest first."""
        with self._session() as session:
            rows = session.scalars(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.id.desc())
                .limit(limit)
            ).all()
            return [self._message_dict(m) for m in reversed(rows)]

    # ---- tool call log ----------------------------------------------------

    def log_tool_call(
        self,
        *,
        client_id: str,
        conversation_id: str,
        name: str,
        args: dict[str, Any],
        ok: bool,
        summary: str,
        source: str,
        duration_ms: int,
        cached: bool,
    ) -> None:
        with self._session() as session:
            session.add(
                ToolCallLog(
                    client_id=client_id,
                    conversation_id=conversation_id,
                    name=name,
                    args=args,
                    ok=ok,
                    summary=summary[:2000],
                    source=source[:80],
                    duration_ms=duration_ms,
                    cached=cached,
                )
            )
            session.commit()

    def activity(self, client_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self._session() as session:
            rows = session.scalars(
                select(ToolCallLog)
                .where(ToolCallLog.client_id == client_id)
                .order_by(ToolCallLog.id.desc())
                .limit(limit)
            ).all()
            return [
                {
                    "id": row.id,
                    "conversation_id": row.conversation_id,
                    "name": row.name,
                    "args": row.args or {},
                    "ok": row.ok,
                    "summary": row.summary,
                    "source": row.source,
                    "duration_ms": row.duration_ms,
                    "cached": row.cached,
                    "created_at": _iso(row.created_at),
                }
                for row in rows
            ]

    # ---- memories: short facts the person asked Aura to keep --------------

    MAX_MEMORIES = 200

    @staticmethod
    def _memory_dict(note: MemoryNote) -> dict[str, Any]:
        return {"id": note.id, "text": note.text, "created_at": _iso(note.created_at)}

    def add_memory(self, client_id: str, text: str) -> dict[str, Any]:
        """Save a fact. Saying the same thing twice keeps one copy."""
        text = " ".join(text.split())[:500]
        with self._session() as session:
            existing = session.scalars(
                select(MemoryNote).where(MemoryNote.client_id == client_id, func.lower(MemoryNote.text) == text.lower())
            ).first()
            if existing is not None:
                return self._memory_dict(existing)
            count = session.scalar(select(func.count()).select_from(MemoryNote).where(MemoryNote.client_id == client_id))
            if (count or 0) >= self.MAX_MEMORIES:
                oldest = session.scalars(
                    select(MemoryNote).where(MemoryNote.client_id == client_id).order_by(MemoryNote.id).limit(1)
                ).first()
                if oldest is not None:
                    session.delete(oldest)
            note = MemoryNote(client_id=client_id, text=text)
            session.add(note)
            session.commit()
            return self._memory_dict(note)

    def list_memories(self, client_id: str, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
        """Newest first. A query keeps only facts containing every one of its words."""
        with self._session() as session:
            statement = select(MemoryNote).where(MemoryNote.client_id == client_id)
            for word in query.lower().split()[:6]:
                statement = statement.where(func.lower(MemoryNote.text).contains(word))
            rows = session.scalars(statement.order_by(MemoryNote.id.desc()).limit(limit)).all()
            return [self._memory_dict(n) for n in rows]

    def delete_memory(self, client_id: str, memory_id: int) -> bool:
        with self._session() as session:
            note = session.get(MemoryNote, memory_id)
            if note is None or note.client_id != client_id:
                return False
            session.delete(note)
            session.commit()
            return True

    def clear_memories(self, client_id: str) -> int:
        with self._session() as session:
            result = session.execute(delete(MemoryNote).where(MemoryNote.client_id == client_id))
            session.commit()
            return int(result.rowcount or 0)

    # ---- agent runs ---------------------------------------------------------

    def save_run(self, client_id: str, run: dict[str, Any]) -> None:
        """Insert or update one run's trace."""
        with self._session() as session:
            row = session.get(AgentRun, run["id"])
            if row is None:
                row = AgentRun(id=run["id"], client_id=client_id)
                session.add(row)
            elif row.client_id != client_id:
                return
            row.conversation_id = run.get("conversation_id") or ""
            row.task = run.get("task") or ""
            row.status = run.get("status") or "running"
            row.plan = run.get("plan") or {}
            row.steps = run.get("steps") or []
            row.answer = run.get("answer") or ""
            row.meta = run.get("meta") or {}
            session.commit()

    @staticmethod
    def _run_dict(row: AgentRun, full: bool) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": row.id,
            "conversation_id": row.conversation_id,
            "task": row.task,
            "status": row.status,
            "created_at": _iso(row.created_at),
            "meta": row.meta or {},
            "step_count": len(row.steps or []),
        }
        if full:
            out.update(plan=row.plan or {}, steps=row.steps or [], answer=row.answer)
        return out

    def list_runs(self, client_id: str, limit: int = 30) -> list[dict[str, Any]]:
        with self._session() as session:
            rows = session.scalars(
                select(AgentRun).where(AgentRun.client_id == client_id).order_by(AgentRun.created_at.desc()).limit(limit)
            ).all()
            return [self._run_dict(r, full=False) for r in rows]

    def get_run(self, client_id: str, run_id: str) -> dict[str, Any] | None:
        with self._session() as session:
            row = session.get(AgentRun, run_id)
            if row is None or row.client_id != client_id:
                return None
            return self._run_dict(row, full=True)

    def close(self) -> None:
        self.engine.dispose()
