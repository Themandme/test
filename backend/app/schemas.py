"""Pydantic models — the API surface.

These mirror data/schema/*.json exactly. The ActivationPayload is the contract the
SwiftUI app caches offline.
"""
from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

E164 = r"^\+[1-9][0-9]{7,14}$"
HEX = r"^#[0-9A-Fa-f]{6}$"


# ---- Directory (national brands) -------------------------------------------------
class Verification(BaseModel):
    status: Literal["unverified_seed", "web_corroborated", "verified", "flagged_stale"]
    source: str | None = None
    verified_on: str | None = None
    verified_by: str | None = None


class Brand(BaseModel):
    id: str
    name: str
    category: str
    support_type: Literal["phone", "online_only"]
    phone: str | None = None
    phone_display: str | None = None
    brand_color_hex: str = Field(pattern=HEX)
    text_color_hex: str = Field(pattern=HEX)
    safety_warning: str
    official_url: str
    official_support_url: str
    verification: Verification


class BrandsResponse(BaseModel):
    schema_version: str
    count: int
    categories: list[str]
    brands: list[Brand]


# ---- Caregiver-managed contacts --------------------------------------------------
class EmergencyContactIn(BaseModel):
    name: str
    phone: str = Field(pattern=E164)
    phone_display: str
    relationship: str
    photo_url: str | None = None


class EmergencyContactOut(EmergencyContactIn):
    model_config = ConfigDict(from_attributes=True)


class CustomContactIn(BaseModel):
    name: str
    phone: str = Field(pattern=E164)
    phone_display: str
    category: str
    photo_url: str | None = None
    note: str | None = None


class CustomContactOut(CustomContactIn):
    model_config = ConfigDict(from_attributes=True)
    id: str


# ---- Activation payload (cached on device) --------------------------------------
class SeniorProfile(BaseModel):
    display_name: str


class Limits(BaseModel):
    max_custom_contacts: int | None


class ActivationPayload(BaseModel):
    account_id: str
    tier: Literal["free", "premium"]
    senior_profile: SeniorProfile
    emergency_contact: EmergencyContactOut | None
    custom_contacts: list[CustomContactOut]
    limits: Limits
    # Stored as the exact ISO string that gets signed, so the app verifies over the
    # identical bytes it receives (no datetime serialization ambiguity).
    issued_at: str
    signature: str


# ---- Account creation / admin ----------------------------------------------------
class AccountCreatedOut(BaseModel):
    account_id: str
    tier: str
    activation_code: str
    caregiver_api_key: str


class SigningKeyOut(BaseModel):
    algorithm: str = "ed25519"
    public_key_b64: str


# ---- Web checkout funnel ---------------------------------------------------------
class CheckoutSessionIn(BaseModel):
    plan: Literal["monthly", "yearly"]
    ref: str | None = None  # influencer/affiliate tracking ref


class CheckoutSessionOut(BaseModel):
    checkout_url: str
    simulated: bool = False


class CheckoutResultOut(BaseModel):
    status: Literal["ready", "pending"]
    activation_code: str | None = None
    tier: str | None = None
