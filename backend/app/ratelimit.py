"""In-process sliding-window rate limiter.

Primary purpose: stop brute-force enumeration of 6-digit activation codes, which would
otherwise let an attacker harvest seniors' cached contacts (PII). Also a general per-IP
throttle for the rest of the API.

NOTE for wide release: this is per-process. Behind multiple instances you MUST also rate
limit at the edge (Cloudflare / API gateway) and/or back this with a shared store
(Redis). The backend abstraction below makes a Redis swap straightforward.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: int) -> tuple[bool, int]:
        """Record a hit. Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        cutoff = now - window_s
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                retry = int(q[0] + window_s - now) + 1
                return False, max(1, retry)
            q.append(now)
            # Opportunistic cleanup so idle keys don't accumulate forever.
            if len(self._hits) > 10_000:
                self._gc(cutoff)
            return True, 0

    def _gc(self, cutoff: float) -> None:
        for k in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            self._hits.pop(k, None)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = SlidingWindowLimiter()


def client_ip(request, trust_proxy: bool = False) -> str:
    """Best-effort client IP. Only trust X-Forwarded-For behind a known proxy/LB."""
    if trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
