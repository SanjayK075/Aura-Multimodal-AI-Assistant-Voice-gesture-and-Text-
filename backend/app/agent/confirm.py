"""Asking the person before a consequential action runs.

When the agent wants to do something with real effect (unlock the door, delete
saved memories) it opens a pending confirmation, tells the browser over the
event stream, and waits. The browser answers through
POST /api/runs/{run_id}/confirm. No answer within the timeout counts as "no".
"""
from __future__ import annotations

import asyncio
from typing import Any


class Confirmations:
    def __init__(self, timeout: float = 90.0) -> None:
        self.timeout = timeout
        self._pending: dict[tuple[str, str], asyncio.Future[bool]] = {}

    def open(self, run_id: str, step_id: str) -> None:
        """Register a question before telling the browser about it, so an
        answer that arrives very quickly still finds it."""
        loop = asyncio.get_running_loop()
        self._pending[(run_id, step_id)] = loop.create_future()

    def resolve(self, run_id: str, step_id: str, approved: bool) -> bool:
        """Record the person's answer. False if nothing was waiting for it."""
        future = self._pending.get((run_id, step_id))
        if future is None or future.done():
            return False
        future.set_result(bool(approved))
        return True

    async def wait(self, run_id: str, step_id: str, timeout: float | None = None) -> bool | None:
        """The answer, or None if none came in time (treated as a refusal)."""
        future = self._pending.get((run_id, step_id))
        if future is None:
            return None
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout or self.timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            self._pending.pop((run_id, step_id), None)

    def pending(self, run_id: str) -> list[str]:
        return [step for (run, step), f in self._pending.items() if run == run_id and not f.done()]

    def cancel_run(self, run_id: str) -> None:
        """The stream closed (tab shut, Stop pressed): refuse anything still waiting."""
        for (run, step), future in list(self._pending.items()):
            if run == run_id and not future.done():
                future.set_result(False)


def describe_action(label: str, args: dict[str, Any]) -> str:
    """A plain question for the confirmation card when a tool has no wording of its own."""
    details = ", ".join(f"{k}: {v}" for k, v in args.items() if v not in (None, "", [], {}))
    return f"{label}{f' ({details})' if details else ''}. Go ahead?"
