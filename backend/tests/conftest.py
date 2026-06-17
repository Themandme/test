"""Test fixtures. Sets env BEFORE importing the app so settings/engine pick it up."""
from __future__ import annotations

import base64
import os
import tempfile

# Deterministic signing key so signature assertions are stable.
os.environ["SIGNING_KEY_SEED_B64"] = base64.b64encode(b"\x01" * 32).decode()
# Isolated temp DB per test session.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
# Map a known price id to premium for webhook tests.
os.environ["STRIPE_PREMIUM_PRICE_IDS"] = "price_premium_test"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import init_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _db():
    init_db()
    yield


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    # Rate-limit state is process-global; clear it so tests don't bleed into each other.
    from app.ratelimit import limiter

    limiter.reset()
    yield


@pytest.fixture
def client():
    return TestClient(app)
