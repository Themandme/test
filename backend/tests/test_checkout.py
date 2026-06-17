"""Web checkout funnel tests (simulated path — no Stripe keys configured in tests)."""
from __future__ import annotations


def test_simulated_checkout_provisions_and_returns_code(client):
    # Caregiver clicks an influencer link and starts checkout.
    r = client.post("/v1/checkout/session", json={"plan": "yearly", "ref": "influencerA"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["simulated"] is True
    assert "session_id=cs_sim_" in body["checkout_url"]

    # The success page extracts session_id and resolves the activation code.
    session_id = body["checkout_url"].split("session_id=")[1].split("&")[0]
    r2 = client.get("/v1/checkout/result", params={"session_id": session_id})
    assert r2.status_code == 200, r2.text
    result = r2.json()
    assert result["status"] == "ready"
    assert result["tier"] == "premium"
    code = result["activation_code"]
    assert len(code) == 6 and code.isdigit()

    # And that code activates the app.
    assert client.get(f"/v1/activate/{code}").status_code == 200


def test_checkout_rejects_unknown_plan(client):
    r = client.post("/v1/checkout/session", json={"plan": "weekly"})
    assert r.status_code == 422  # pydantic Literal rejects it


def test_checkout_result_pending_for_unknown_session(client):
    r = client.get("/v1/checkout/result", params={"session_id": "cs_sim_does_not_exist"})
    assert r.status_code == 200
    assert r.json()["status"] == "pending"


def test_referral_ref_recorded(client):
    r = client.post("/v1/checkout/session", json={"plan": "monthly", "ref": "podcastB"})
    session_id = r.json()["checkout_url"].split("session_id=")[1].split("&")[0]
    # Resolve to ensure the account exists, then confirm ref persisted.
    client.get("/v1/checkout/result", params={"session_id": session_id})

    from app.database import SessionLocal
    from app import models

    db = SessionLocal()
    acct = (
        db.query(models.Account)
        .filter(models.Account.stripe_checkout_session_id == session_id)
        .one()
    )
    assert acct.referral_ref == "podcastB"
    db.close()
