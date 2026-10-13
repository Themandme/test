"""Stripe webhook handling — the funnel's server side.

Web checkout (with Apple Pay) completes -> Stripe fires checkout.session.completed ->
we create a Master Account and a 6-digit activation code, and map the purchased price
to the entitlement tier. The mobile app never sees any of this; the caregiver gets the
code on the web success page / by email.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from . import accounts, models
from .config import get_settings


def _tier_for_price_ids(price_ids: set[str]) -> str:
    premium = get_settings().premium_price_id_set()
    return "premium" if price_ids & premium else "free"


def verify_and_parse_event(payload: bytes, sig_header: str) -> dict:
    """Verify the Stripe signature and return the event dict. Raises on bad signature."""
    import stripe

    settings = get_settings()
    return stripe.Webhook.construct_event(
        payload=payload, sig_header=sig_header, secret=settings.stripe_webhook_secret
    )


def handle_event(db: Session, event: dict) -> models.Account | None:
    """Process a Stripe event. Returns the created/updated account, if any.

    Idempotent on Stripe subscription id so retried webhooks don't create duplicates.
    """
    etype = event.get("type")
    obj = event.get("data", {}).get("object", {})

    if etype == "checkout.session.completed":
        customer_id = obj.get("customer")
        subscription_id = obj.get("subscription")

        # Dedupe: if we already provisioned this subscription, return it.
        if subscription_id:
            existing = (
                db.query(models.Account)
                .filter(models.Account.stripe_subscription_id == subscription_id)
                .one_or_none()
            )
            if existing:
                return existing

        price_ids = _extract_price_ids(obj)
        tier = _tier_for_price_ids(price_ids)
        ref = (obj.get("metadata") or {}).get("ref") or obj.get("client_reference_id")
        return accounts.create_account(
            db,
            tier=tier,
            stripe_customer_id=customer_id,
            stripe_subscription_id=subscription_id,
            stripe_checkout_session_id=obj.get("id"),
            referral_ref=ref,
        )

    if etype in {"customer.subscription.updated", "customer.subscription.deleted"}:
        subscription_id = obj.get("id")
        account = (
            db.query(models.Account)
            .filter(models.Account.stripe_subscription_id == subscription_id)
            .one_or_none()
        )
        if account is None:
            return None
        if etype == "customer.subscription.deleted" or obj.get("status") in {
            "canceled",
            "unpaid",
            "incomplete_expired",
        }:
            account.tier = "free"  # downgrade; free tier still works offline
        else:
            account.tier = _tier_for_price_ids(_extract_price_ids(obj))
        db.commit()
        db.refresh(account)
        return account

    return None


def _extract_price_ids(obj: dict) -> set[str]:
    """Pull price ids from either a checkout session (line_items) or a subscription."""
    ids: set[str] = set()
    # Subscription object
    for item in obj.get("items", {}).get("data", []):
        price = item.get("price", {})
        if price.get("id"):
            ids.add(price["id"])
    # Checkout session with expanded line items
    for item in obj.get("line_items", {}).get("data", []):
        price = item.get("price", {})
        if price.get("id"):
            ids.add(price["id"])
    # Fallback single price hint
    if obj.get("price"):
        ids.add(obj["price"])
    return ids
