"""Redis rate-limiter backend tests (using fakeredis for the Lua sliding window)."""
from __future__ import annotations

import pytest

fakeredis = pytest.importorskip("fakeredis")

from app.ratelimit import RedisSlidingWindowLimiter  # noqa: E402


def test_redis_limiter_enforces_exact_limit():
    client = fakeredis.FakeRedis()
    lim = RedisSlidingWindowLimiter(client)
    allowed = [lim.allow("act:1.2.3.4", limit=3, window_s=60)[0] for _ in range(5)]
    assert allowed == [True, True, True, False, False]
    # The blocked response advertises a positive retry-after.
    assert lim.allow("act:1.2.3.4", 3, 60)[1] >= 1


def test_redis_limit_is_shared_across_instances():
    # Two limiter objects on the same Redis = two app instances/workers. The combined
    # count must respect the single limit — the whole point of the shared backend.
    client = fakeredis.FakeRedis()
    inst_a = RedisSlidingWindowLimiter(client)
    inst_b = RedisSlidingWindowLimiter(client)
    results = []
    for i in range(6):
        limiter = inst_a if i % 2 == 0 else inst_b
        results.append(limiter.allow("act:9.9.9.9", limit=4, window_s=60)[0])
    assert sum(results) == 4  # exact across both instances, not 4 per instance


def test_redis_keys_are_isolated_per_key():
    client = fakeredis.FakeRedis()
    lim = RedisSlidingWindowLimiter(client)
    assert all(lim.allow(f"api:{ip}", 2, 60)[0] for ip in ("a", "b", "c"))


def test_redis_failure_fails_open():
    # If Redis errors, the limiter must allow (degrade protection, don't break the API).
    class Boom:
        def __call__(self, *a, **k):
            raise RuntimeError("redis down")

    lim = RedisSlidingWindowLimiter.__new__(RedisSlidingWindowLimiter)
    lim._r = None
    lim._script = Boom()
    assert lim.allow("act:1.1.1.1", 1, 60) == (True, 0)
