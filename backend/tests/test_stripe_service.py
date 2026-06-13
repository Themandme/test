"""Unit tests for Stripe event handling (no real Stripe calls)."""
from __future__ import annotations

from app import stripe_service
from app.database import SessionLocal


def _session():
    return SessionLocal()


def test_checkout_completed_provisions_premium():
    db = _session()
    event = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "customer": "cus_123",
                "subscription": "sub_premium_1",
                "line_items": {"data": [{"price": {"id": "price_premium_test"}}]},
            }
        },
    }
    account = stripe_service.handle_event(db, event)
    assert account is not None
    assert account.tier == "premium"
    assert account.stripe_subscription_id == "sub_premium_1"
    assert len(account.activation_code.code) == 6
    db.close()


def test_checkout_is_idempotent_on_subscription():
    db = _session()
    event = {
        "type": "checkout.session.completed",
        "data": {"object": {"customer": "cus_x", "subscription": "sub_dupe", "line_items": {"data": []}}},
    }
    a1 = stripe_service.handle_event(db, event)
    a2 = stripe_service.handle_event(db, event)
    assert a1.id == a2.id  # retried webhook must not create a second account
    db.close()


def test_subscription_canceled_downgrades_to_free():
    db = _session()
    created = stripe_service.handle_event(
        db,
        {
            "type": "checkout.session.completed",
            "data": {"object": {"customer": "cus_d", "subscription": "sub_cancel", "line_items": {"data": [{"price": {"id": "price_premium_test"}}]}}},
        },
    )
    assert created.tier == "premium"

    updated = stripe_service.handle_event(
        db,
        {"type": "customer.subscription.deleted", "data": {"object": {"id": "sub_cancel", "status": "canceled"}}},
    )
    assert updated.tier == "free"
    db.close()
