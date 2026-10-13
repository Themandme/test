"""Production-safety / hardening tests."""
from __future__ import annotations

from app import accounts, models
from app.config import Settings
from app.database import SessionLocal


def _create_account(client, tier="free"):
    return client.post("/v1/dev/accounts", params={"tier": tier}).json()


# ---- Activation brute-force protection -------------------------------------------
def test_activation_endpoint_is_rate_limited(client):
    acct = _create_account(client)
    code = acct["activation_code"]
    statuses = [client.get(f"/v1/activate/{code}").status_code for _ in range(15)]
    # The valid code returns 200 until the per-IP limit trips, then 429.
    assert 429 in statuses, statuses
    assert statuses.index(429) <= 9  # default limit is 8/min
    # And a Retry-After is advertised.
    r = client.get(f"/v1/activate/{code}")
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) >= 1


# ---- API keys hashed at rest -----------------------------------------------------
def test_caregiver_api_key_stored_hashed(client):
    acct = _create_account(client)
    plaintext = acct["caregiver_api_key"]

    db = SessionLocal()
    row = db.query(models.Account).filter(models.Account.id == acct["account_id"]).one()
    # The plaintext must never be at rest — only its hash.
    assert row.caregiver_api_key_hash == accounts.hash_api_key(plaintext)
    assert row.caregiver_api_key_hash != plaintext
    db.close()

    # The plaintext still authenticates; a wrong key does not.
    assert client.get("/v1/account/contacts", headers={"X-API-Key": plaintext}).status_code == 200
    assert client.get("/v1/account/contacts", headers={"X-API-Key": "cgk_wrong"}).status_code == 401


# ---- Security headers ------------------------------------------------------------
def test_security_headers_present(client):
    r = client.get("/v1/brands")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Cache-Control"] == "no-store"


# ---- Fail-closed production config (unit-level, no running app) -------------------
def test_production_requires_secrets_and_real_db():
    s = Settings(
        environment="production",
        signing_key_seed_b64="",          # missing
        database_url="sqlite:///./x.db",  # not allowed in prod
        stripe_webhook_secret="",         # missing
        enable_dev_endpoints=True,        # must be off
    )
    problems = s.validate_for_runtime()
    assert any("SIGNING_KEY_SEED_B64" in p for p in problems)
    assert any("Postgres" in p for p in problems)
    assert any("WEBHOOK_SECRET" in p for p in problems)
    assert any("DEV_ENDPOINTS" in p for p in problems)


def test_production_config_clean_passes():
    s = Settings(
        environment="production",
        signing_key_seed_b64="QUJDt, ignored length here",
        database_url="postgresql://user:pw@db/app",
        stripe_webhook_secret="whsec_x",
        enable_dev_endpoints=False,
        web_base_url="https://safe-numbers.app",
        extra_cors_origins="",
    )
    assert s.validate_for_runtime() == []
    assert s.dev_endpoints_enabled is False


def test_dev_endpoints_disabled_in_production():
    s = Settings(environment="production", enable_dev_endpoints=True)
    assert s.dev_endpoints_enabled is False
