"""Web checkout funnel — the server side of 'Web Checkout First'.

Flow:
  influencer link (?ref=) -> landing page -> POST /v1/checkout/session
    -> redirect to Stripe Checkout (Apple Pay enabled) -> success page
    -> GET /v1/checkout/result?session_id=... -> shows the 6-digit code.

When Stripe is not configured (local dev), a SIMULATED session is used: the account
is provisioned immediately so the whole funnel can be exercised end-to-end without keys.
The mobile app is never involved here — it only consumes the resulting code.
"""
from __future__ import annotations

import secrets

from sqlalchemy.orm import Session

from . import accounts, models
from .config import get_settings


class CheckoutError(Exception):
    pass


def create_session(db: Session, *, plan: str, ref: str | None) -> dict:
    """Returns {'checkout_url': str, 'simulated': bool}."""
    if plan not in {"monthly", "yearly"}:
        raise CheckoutError("plan must be 'monthly' or 'yearly'")

    settings = get_settings()

    if not settings.stripe_enabled:
        # Dev simulation: provision now, hand back a success URL the page can resolve.
        sid = f"cs_sim_{secrets.token_hex(8)}"
        accounts.create_account(
            db, tier="premium", stripe_checkout_session_id=sid, referral_ref=ref
        )
        url = f"{settings.web_base_url}/success.html?session_id={sid}&simulated=1"
        return {"checkout_url": url, "simulated": True}

    import stripe

    stripe.api_key = settings.stripe_api_key
    price_id = settings.price_id_for_plan(plan)
    if not price_id:
        raise CheckoutError(f"no Stripe price configured for plan '{plan}'")

    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        # card covers Apple Pay automatically in Stripe Checkout.
        success_url=f"{settings.web_base_url}/success.html?session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{settings.web_base_url}/?canceled=1",
        client_reference_id=ref or None,
        metadata={"ref": ref or ""},
        allow_promotion_codes=True,
    )
    return {"checkout_url": session.url, "simulated": False}


def result_for_session(db: Session, session_id: str) -> dict | None:
    """Returns {'activation_code', 'tier'} once the account exists, else None (pending)."""
    account = (
        db.query(models.Account)
        .filter(models.Account.stripe_checkout_session_id == session_id)
        .one_or_none()
    )

    # Real Stripe: the webhook may not have landed yet. Fall back to retrieving the
    # session directly and provisioning on demand (idempotent on the session id).
    if account is None and get_settings().stripe_enabled and not session_id.startswith("cs_sim_"):
        account = _provision_from_stripe_session(db, session_id)

    if account is None:
        return None
    return {"activation_code": account.activation_code.code, "tier": account.tier}


def _provision_from_stripe_session(db: Session, session_id: str) -> models.Account | None:
    import stripe

    settings = get_settings()
    stripe.api_key = settings.stripe_api_key
    try:
        session = stripe.checkout.Session.retrieve(session_id)
    except Exception:
        return None
    if session.get("payment_status") not in {"paid", "no_payment_required"}:
        return None  # not paid yet -> still pending

    ref = (session.get("metadata") or {}).get("ref") or session.get("client_reference_id")
    account = accounts.create_account(
        db,
        tier="premium",
        stripe_customer_id=session.get("customer"),
        stripe_subscription_id=session.get("subscription"),
        stripe_checkout_session_id=session_id,
        referral_ref=ref,
    )
    return account
