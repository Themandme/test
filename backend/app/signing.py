"""Ed25519 signing of activation payloads.

The signature is the integrity backbone of the 'spoof-resistant' claim: the app
verifies it with the public key (fetched from /v1/signing-key) so a tampered cache or
man-in-the-middle cannot silently swap in a scammer's number.

Canonical signing string (stable, order-independent of JSON formatting):

    account_id | tier | issued_at_iso | sha256(canonical_contacts_json)

where canonical_contacts_json is a compact, sorted-key JSON of the emergency contact
and custom contacts. Keeping this explicit (rather than signing the whole rendered
JSON) means formatting changes never invalidate signatures.
"""
from __future__ import annotations

import base64
import hashlib
import json
from functools import lru_cache

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .config import get_settings


@lru_cache
def _private_key() -> Ed25519PrivateKey:
    return get_settings().load_signing_key()


def public_key_b64() -> str:
    pub: Ed25519PublicKey = _private_key().public_key()
    raw = pub.public_bytes_raw()
    return base64.b64encode(raw).decode()


def _contacts_hash(emergency: dict | None, custom: list[dict]) -> str:
    blob = json.dumps(
        {"emergency": emergency, "custom": custom},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode()).hexdigest()


def canonical_string(
    account_id: str, tier: str, issued_at_iso: str, emergency: dict | None, custom: list[dict]
) -> str:
    return f"{account_id}|{tier}|{issued_at_iso}|{_contacts_hash(emergency, custom)}"


def sign_payload(
    account_id: str, tier: str, issued_at_iso: str, emergency: dict | None, custom: list[dict]
) -> str:
    msg = canonical_string(account_id, tier, issued_at_iso, emergency, custom).encode()
    sig = _private_key().sign(msg)
    return "ed25519:" + base64.b64encode(sig).decode()


def verify_payload(
    signature: str,
    account_id: str,
    tier: str,
    issued_at_iso: str,
    emergency: dict | None,
    custom: list[dict],
) -> bool:
    """Server-side helper (mirrors what the app does) — used in tests."""
    from cryptography.exceptions import InvalidSignature

    if not signature.startswith("ed25519:"):
        return False
    raw = base64.b64decode(signature.split(":", 1)[1])
    msg = canonical_string(account_id, tier, issued_at_iso, emergency, custom).encode()
    try:
        _private_key().public_key().verify(raw, msg)
        return True
    except InvalidSignature:
        return False
