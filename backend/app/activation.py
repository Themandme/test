"""Builds the signed ActivationPayload from an Account."""
from __future__ import annotations

import datetime as dt

from . import models, signing
from .schemas import (
    ActivationPayload,
    CustomContactOut,
    EmergencyContactOut,
    Limits,
    SeniorProfile,
)


def _emergency_dict(ec: models.EmergencyContact | None) -> dict | None:
    if ec is None:
        return None
    return {
        "name": ec.name,
        "phone": ec.phone,
        "phone_display": ec.phone_display,
        "relationship": ec.relationship_label,
        "photo_url": ec.photo_url,
    }


def _custom_list(account: models.Account) -> list[dict]:
    return [
        {
            "id": c.id,
            "name": c.name,
            "phone": c.phone,
            "phone_display": c.phone_display,
            "category": c.category,
            "photo_url": c.photo_url,
            "note": c.note,
        }
        for c in account.custom_contacts
    ]


def build_payload(account: models.Account) -> ActivationPayload:
    issued_at = dt.datetime.now(dt.timezone.utc)
    issued_at_iso = issued_at.isoformat()

    emergency = _emergency_dict(account.emergency_contact)
    custom = _custom_list(account)

    signature = signing.sign_payload(account.id, account.tier, issued_at_iso, emergency, custom)

    return ActivationPayload(
        account_id=account.id,
        tier=account.tier,  # type: ignore[arg-type]
        senior_profile=SeniorProfile(display_name=account.senior_display_name),
        emergency_contact=EmergencyContactOut(**emergency) if emergency else None,
        custom_contacts=[CustomContactOut(**c) for c in custom],
        limits=Limits(max_custom_contacts=account.max_custom_contacts),
        issued_at=issued_at_iso,
        signature=signature,
    )
