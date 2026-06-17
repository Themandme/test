"""FastAPI application + routes.

Public app endpoints (consumed by the SwiftUI app):
  GET  /v1/brands              -> the hardcoded national directory
  GET  /v1/signing-key         -> Ed25519 public key for verifying payloads
  GET  /v1/activate/{code}     -> signed, offline-cacheable ActivationPayload

Funnel:
  POST /v1/webhooks/stripe     -> provisions account + 6-digit code after checkout

Caregiver dashboard (web; X-API-Key auth):
  GET/PUT  /v1/account/emergency-contact
  GET/POST/DELETE /v1/account/contacts
"""
from __future__ import annotations

import logging
import secrets

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from . import accounts, activation, checkout, models, ratelimit, signing, stripe_service
from .brands import load_brands
from .config import get_settings
from .database import get_db, init_db

log = logging.getLogger("senior_directory")
from .schemas import (
    AccountCreatedOut,
    ActivationPayload,
    BrandsResponse,
    CheckoutResultOut,
    CheckoutSessionIn,
    CheckoutSessionOut,
    CustomContactIn,
    CustomContactOut,
    EmergencyContactIn,
    EmergencyContactOut,
    SigningKeyOut,
)

app = FastAPI(title="Senior Directory API", version="1.0.0")
_settings = get_settings()

# The web funnel is served from a different origin than the API, so allow it via CORS.
# The mobile app is not a browser and is unaffected. Origins are restricted (no "*").
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins(),
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-API-Key"],
)


@app.middleware("http")
async def rate_limit_and_headers(request: Request, call_next):
    s = get_settings()
    limiter = ratelimit.get_limiter()
    ip = ratelimit.client_ip(request, trust_proxy=s.is_production)
    path = request.url.path

    if path.startswith("/v1/activate/"):
        # Hard limit + global circuit breaker: activation returns PII keyed on a
        # 6-digit code, so enumeration must be throttled aggressively.
        ok, retry = limiter.allow(f"act:{ip}", s.activation_rate_limit, s.activation_rate_window_s)
        gok, gretry = limiter.allow("act:global", s.activation_global_limit, s.activation_rate_window_s)
        if not ok or not gok:
            return JSONResponse(
                {"detail": "Too many attempts. Please wait and try again."},
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                headers={"Retry-After": str(retry or gretry)},
            )
    elif path != "/health":
        ok, retry = limiter.allow(f"api:{ip}", s.api_rate_limit, s.api_rate_window_s)
        if not ok:
            return JSONResponse(
                {"detail": "Too many requests."},
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                headers={"Retry-After": str(retry)},
            )

    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if s.is_production:
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


@app.on_event("startup")
def _startup() -> None:
    problems = _settings.validate_for_runtime()
    if problems:
        msg = "Refusing to start — production safety checks failed:\n  - " + "\n  - ".join(problems)
        raise RuntimeError(msg)
    init_db()
    load_brands()  # warm the cache / fail fast on a bad dataset


# ---- Health & directory ----------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/v1/brands", response_model=BrandsResponse)
def get_brands() -> BrandsResponse:
    return load_brands()


@app.get("/v1/signing-key", response_model=SigningKeyOut)
def get_signing_key() -> SigningKeyOut:
    return SigningKeyOut(public_key_b64=signing.public_key_b64())


# ---- Activation (app fetches once, then caches offline) --------------------------
@app.get("/v1/activate/{code}", response_model=ActivationPayload)
def activate(code: str, db: Session = Depends(get_db)) -> ActivationPayload:
    if not (len(code) == 6 and code.isdigit()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Activation code must be 6 digits")

    record = db.get(models.ActivationCode, code)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid activation code")

    if record.activated_at is None:
        record.activated_at = models.utcnow()
    record.fetch_count += 1
    db.commit()

    return activation.build_payload(record.account)


# ---- Web checkout funnel ---------------------------------------------------------
@app.post("/v1/checkout/session", response_model=CheckoutSessionOut)
def create_checkout_session(
    body: CheckoutSessionIn, db: Session = Depends(get_db)
) -> CheckoutSessionOut:
    try:
        result = checkout.create_session(db, plan=body.plan, ref=body.ref)
    except checkout.CheckoutError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return CheckoutSessionOut(**result)


@app.get("/v1/checkout/result", response_model=CheckoutResultOut)
def checkout_result(session_id: str, db: Session = Depends(get_db)) -> CheckoutResultOut:
    result = checkout.result_for_session(db, session_id)
    if result is None:
        # Account not provisioned yet (webhook in flight) — the page should poll.
        return CheckoutResultOut(status="pending")
    return CheckoutResultOut(status="ready", **result)


# ---- Stripe webhook (funnel) -----------------------------------------------------
@app.post("/v1/webhooks/stripe")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    db: Session = Depends(get_db),
) -> dict:
    payload = await request.body()
    try:
        event = stripe_service.verify_and_parse_event(payload, stripe_signature)
    except Exception as exc:  # signature failure / malformed
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Webhook error: {exc}") from exc

    account = stripe_service.handle_event(db, event)
    if account is None:
        return {"received": True, "provisioned": False}
    return {
        "received": True,
        "provisioned": True,
        "account_id": account.id,
        "activation_code": account.activation_code.code,
        "tier": account.tier,
    }


# ---- Caregiver dashboard auth ----------------------------------------------------
def caregiver_account(
    x_api_key: str = Header(default="", alias="X-API-Key"),
    db: Session = Depends(get_db),
) -> models.Account:
    account = accounts.account_for_api_key(db, x_api_key) if x_api_key else None
    if account is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing API key")
    return account


@app.get("/v1/account/emergency-contact", response_model=EmergencyContactOut | None)
def get_emergency_contact(
    account: models.Account = Depends(caregiver_account),
) -> EmergencyContactOut | None:
    ec = account.emergency_contact
    if ec is None:
        return None
    return EmergencyContactOut(
        name=ec.name,
        phone=ec.phone,
        phone_display=ec.phone_display,
        relationship=ec.relationship_label,
        photo_url=ec.photo_url,
    )


@app.put("/v1/account/emergency-contact", response_model=EmergencyContactOut)
def set_emergency_contact(
    body: EmergencyContactIn,
    account: models.Account = Depends(caregiver_account),
    db: Session = Depends(get_db),
) -> EmergencyContactOut:
    ec = account.emergency_contact
    if ec is None:
        ec = models.EmergencyContact(account_id=account.id)
        db.add(ec)
    ec.name = body.name
    ec.phone = body.phone
    ec.phone_display = body.phone_display
    ec.relationship_label = body.relationship
    ec.photo_url = body.photo_url
    db.commit()
    return body  # echoes the validated input


@app.get("/v1/account/contacts", response_model=list[CustomContactOut])
def list_contacts(
    account: models.Account = Depends(caregiver_account),
) -> list[CustomContactOut]:
    return [CustomContactOut.model_validate(c) for c in account.custom_contacts]


@app.post("/v1/account/contacts", response_model=CustomContactOut, status_code=201)
def add_contact(
    body: CustomContactIn,
    account: models.Account = Depends(caregiver_account),
    db: Session = Depends(get_db),
) -> CustomContactOut:
    limit = account.max_custom_contacts
    if limit is not None and len(account.custom_contacts) >= limit:
        # Neutral limit message; the app/web surface decides how to present upgrades.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "contact_limit_reached", "max_custom_contacts": limit},
        )
    contact = models.CustomContact(
        id=f"cc_{secrets.token_hex(6)}",
        account_id=account.id,
        name=body.name,
        phone=body.phone,
        phone_display=body.phone_display,
        category=body.category,
        photo_url=body.photo_url,
        note=body.note,
    )
    db.add(contact)
    db.commit()
    db.refresh(contact)
    return CustomContactOut.model_validate(contact)


@app.delete("/v1/account/contacts/{contact_id}", status_code=204, response_class=Response)
def delete_contact(
    contact_id: str,
    account: models.Account = Depends(caregiver_account),
    db: Session = Depends(get_db),
) -> Response:
    contact = db.get(models.CustomContact, contact_id)
    if contact is None or contact.account_id != account.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Contact not found")
    db.delete(contact)
    db.commit()
    return Response(status_code=204)


# ---- Dev-only provisioning (no Stripe) -------------------------------------------
# Lets the app/web be exercised end-to-end locally without a real checkout.
# Disabled automatically once a Stripe webhook secret is configured.
@app.post("/v1/dev/accounts", response_model=AccountCreatedOut)
def dev_create_account(
    tier: str = "free",
    senior_display_name: str = "Mom",
    db: Session = Depends(get_db),
) -> AccountCreatedOut:
    if not get_settings().dev_endpoints_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Dev endpoint disabled in this environment")
    if tier not in {"free", "premium"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "tier must be free or premium")
    account = accounts.create_account(db, tier=tier, senior_display_name=senior_display_name)
    return AccountCreatedOut(
        account_id=account.id,
        tier=account.tier,
        activation_code=account.activation_code.code,
        caregiver_api_key=account.plaintext_api_key,  # shown once; only the hash is stored
    )
