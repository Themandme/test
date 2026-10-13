"""Rate limiting with a pluggable backend.

Primary purpose: stop brute-force enumeration of 6-digit activation codes, which would
otherwise let an attacker harvest seniors' cached contacts (PII). Also a general per-IP
throttle for the rest of the API.

Two backends share one interface (`allow(key, limit, window_s) -> (allowed, retry_after)`):

- InMemorySlidingWindowLimiter — per-process; fine for a single instance / local dev.
- RedisSlidingWindowLimiter — shared across all workers and instances, so the configured
  limits are exact at any scale. Selected automatically when REDIS_URL is set.

Set REDIS_URL (e.g. redis://host:6379/0) to switch on the shared backend.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from functools import lru_cache
from typing import Protocol

log = logging.getLogger("senior_directory")

KEY_PREFIX = "rl:"


class RateLimiter(Protocol):
    def allow(self, key: str, limit: int, window_s: int) -> tuple[bool, int]: ...
    def reset(self) -> None: ...


class InMemorySlidingWindowLimiter:
    """Sliding-window log kept in process memory. Not shared across workers/instances."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: int) -> tuple[bool, int]:
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
            if len(self._hits) > 10_000:
                self._gc(cutoff)
            return True, 0

    def _gc(self, cutoff: float) -> None:
        for k in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            self._hits.pop(k, None)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


# Atomic sliding-window check-and-add in Redis. Using a ZSET of timestamps (ms) per key:
# drop entries older than the window, count, reject if full (returning ms until the
# oldest ages out), otherwise add the current hit and refresh the TTL. Atomic so
# concurrent requests across instances can't race past the limit.
_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, window - (now - tonumber(oldest[2]))}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, 0}
"""


class RedisSlidingWindowLimiter:
    """Shared sliding window in Redis — exact limits across workers and instances.

    Fails OPEN (allows the request) if Redis is unreachable, so a Redis outage degrades
    protection rather than taking the whole API down. Edge rate limiting remains the
    backstop for that window.
    """

    def __init__(self, client) -> None:
        self._r = client
        self._script = client.register_script(_LUA)

    def allow(self, key: str, limit: int, window_s: int) -> tuple[bool, int]:
        now_ms = int(time.time() * 1000)
        window_ms = window_s * 1000
        member = f"{now_ms}-{time.perf_counter_ns()}"
        try:
            allowed, retry_ms = self._script(
                keys=[KEY_PREFIX + key], args=[now_ms, window_ms, limit, member]
            )
        except Exception as exc:  # pragma: no cover - network failure path
            log.warning("rate limiter (redis) unavailable, failing open: %s", exc)
            return True, 0
        if int(allowed) == 1:
            return True, 0
        return False, max(1, int(int(retry_ms) / 1000) + 1)

    def reset(self) -> None:
        # Scoped to our prefix so we never flush unrelated keys.
        try:
            for k in self._r.scan_iter(match=KEY_PREFIX + "*"):
                self._r.delete(k)
        except Exception as exc:  # pragma: no cover
            log.warning("rate limiter reset failed: %s", exc)


@lru_cache
def get_limiter() -> RateLimiter:
    from .config import get_settings

    url = get_settings().redis_url
    if url:
        try:
            import redis  # lazy import; only needed when REDIS_URL is set

            client = redis.Redis.from_url(url, socket_timeout=0.25, socket_connect_timeout=0.25)
            log.info("rate limiter: using Redis backend")
            return RedisSlidingWindowLimiter(client)
        except Exception as exc:  # pragma: no cover
            log.error("REDIS_URL set but Redis backend unavailable (%s); using in-memory", exc)
    return InMemorySlidingWindowLimiter()


def client_ip(request, trust_proxy: bool = False) -> str:
    """Best-effort client IP. Only trust X-Forwarded-For behind a known proxy/LB."""
    if trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
