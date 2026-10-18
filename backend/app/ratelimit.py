"""A sliding-window rate limiter held in memory.

Protects the free LLM quota from a runaway client or a stranger hammering the
public URL. In-memory is enough for a single small server; a multi-server
deployment would move this to Redis.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Callable


class RateLimiter:
    def __init__(
        self,
        max_requests: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_requests = max_requests
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> float:
        """Record a request. Returns 0 if allowed, else seconds until the next slot."""
        if self.max_requests <= 0:
            return 0.0
        now = self._clock()
        hits = self._hits[key]
        while hits and now - hits[0] >= self.window:
            hits.popleft()
        if len(hits) >= self.max_requests:
            return max(0.1, self.window - (now - hits[0]))
        hits.append(now)
        # Forget idle clients so the table can't grow without bound.
        if len(self._hits) > 5000:
            for stale in [k for k, v in self._hits.items() if not v or now - v[-1] >= self.window]:
                del self._hits[stale]
        return 0.0
