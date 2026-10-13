"""End-to-end API tests covering the directory, activation, signing, caregiver
contact management with tier limits, and the activation payload signature."""
from __future__ import annotations

from app import signing


def _create_account(client, tier="free"):
    r = client.post("/v1/dev/accounts", params={"tier": tier, "senior_display_name": "Mom"})
    assert r.status_code == 200, r.text
    return r.json()


# ---- Directory -------------------------------------------------------------------
def test_brands_directory(client):
    r = client.get("/v1/brands")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 50
    online_only = [b for b in body["brands"] if b["support_type"] == "online_only"]
    # The no-phone-support brands must carry null phones so the app warns, not dials.
    assert len(online_only) >= 5
    assert all(b["phone"] is None for b in online_only)
    assert all(b["phone"] is not None for b in body["brands"] if b["support_type"] == "phone")


def test_signing_key_exposed(client):
    r = client.get("/v1/signing-key")
    assert r.status_code == 200
    assert r.json()["algorithm"] == "ed25519"
    assert r.json()["public_key_b64"]


# ---- Activation ------------------------------------------------------------------
def test_activation_flow_and_signature(client):
    acct = _create_account(client)
    code = acct["activation_code"]
    assert len(code) == 6 and code.isdigit()

    r = client.get(f"/v1/activate/{code}")
    assert r.status_code == 200, r.text
    payload = r.json()

    assert payload["account_id"] == acct["account_id"]
    assert payload["tier"] == "free"
    assert payload["limits"]["max_custom_contacts"] == 3
    assert payload["emergency_contact"] is None
    assert payload["custom_contacts"] == []

    # Signature must verify against the documented canonical string.
    assert signing.verify_payload(
        payload["signature"],
        payload["account_id"],
        payload["tier"],
        payload["issued_at"],
        None,
        [],
    )


def test_activation_rejects_bad_codes(client):
    assert client.get("/v1/activate/12345").status_code == 400  # too short
    assert client.get("/v1/activate/abcdef").status_code == 400  # non-digit
    assert client.get("/v1/activate/000000").status_code == 404  # well-formed, unknown


# ---- Caregiver contact management + tier limits ----------------------------------
def test_emergency_contact_and_panic_target(client):
    acct = _create_account(client)
    headers = {"X-API-Key": acct["caregiver_api_key"]}

    body = {
        "name": "David",
        "phone": "+15125550148",
        "phone_display": "(512) 555-0148",
        "relationship": "son",
        "photo_url": None,
    }
    assert client.put("/v1/account/emergency-contact", json=body, headers=headers).status_code == 200

    payload = client.get(f"/v1/activate/{acct['activation_code']}").json()
    assert payload["emergency_contact"]["name"] == "David"
    assert payload["emergency_contact"]["phone"] == "+15125550148"


def test_free_tier_contact_limit_enforced(client):
    acct = _create_account(client, tier="free")
    headers = {"X-API-Key": acct["caregiver_api_key"]}

    def add(n):
        return client.post(
            "/v1/account/contacts",
            json={
                "name": f"Contact {n}",
                "phone": f"+1512555010{n}",
                "phone_display": f"(512) 555-010{n}",
                "category": "Doctor",
            },
            headers=headers,
        )

    assert add(1).status_code == 201
    assert add(2).status_code == 201
    assert add(3).status_code == 201
    r = add(4)
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "contact_limit_reached"


def test_premium_tier_unlimited_contacts(client):
    acct = _create_account(client, tier="premium")
    headers = {"X-API-Key": acct["caregiver_api_key"]}
    payload = client.get(f"/v1/activate/{acct['activation_code']}").json()
    assert payload["limits"]["max_custom_contacts"] is None

    for n in range(5):
        r = client.post(
            "/v1/account/contacts",
            json={
                "name": f"P{n}",
                "phone": f"+1512555030{n}",
                "phone_display": f"(512) 555-030{n}",
                "category": "Pharmacy",
            },
            headers=headers,
        )
        assert r.status_code == 201


def test_caregiver_auth_required(client):
    assert client.get("/v1/account/contacts").status_code == 401
    assert client.get("/v1/account/contacts", headers={"X-API-Key": "nope"}).status_code == 401
