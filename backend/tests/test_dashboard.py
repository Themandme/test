"""Caregiver dashboard endpoint tests (X-API-Key auth)."""
from __future__ import annotations


def _account(client, tier="free"):
    return client.post("/v1/dev/accounts", params={"tier": tier}).json()


def test_account_summary(client):
    acct = _account(client)
    headers = {"X-API-Key": acct["caregiver_api_key"]}
    r = client.get("/v1/account", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["account_id"] == acct["account_id"]
    assert body["tier"] == "free"
    assert body["activation_code"] == acct["activation_code"]
    assert body["limits"]["max_custom_contacts"] == 3
    assert body["custom_contacts_count"] == 0


def test_account_summary_requires_auth(client):
    assert client.get("/v1/account").status_code == 401
    assert client.get("/v1/account", headers={"X-API-Key": "nope"}).status_code == 401


def test_update_senior_display_name(client):
    acct = _account(client)
    headers = {"X-API-Key": acct["caregiver_api_key"]}
    r = client.put("/v1/account", json={"senior_display_name": "Grandpa"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["senior_display_name"] == "Grandpa"
    # And it shows up in the activation payload the device caches.
    payload = client.get(f"/v1/activate/{acct['activation_code']}").json()
    assert payload["senior_profile"]["display_name"] == "Grandpa"


def test_contacts_count_reflects_additions(client):
    acct = _account(client)
    headers = {"X-API-Key": acct["caregiver_api_key"]}
    client.post(
        "/v1/account/contacts",
        json={"name": "Dr. Lee", "phone": "+15125550111",
              "phone_display": "(512) 555-0111", "category": "Doctor"},
        headers=headers,
    )
    assert client.get("/v1/account", headers=headers).json()["custom_contacts_count"] == 1
