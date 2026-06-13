"""Account creation + id/code generation."""
from __future__ import annotations

import secrets

from sqlalchemy.orm import Session

from . import models


def _new_id(prefix: str, nbytes: int = 6) -> str:
    return f"{prefix}_{secrets.token_hex(nbytes)}"


def generate_activation_code(db: Session) -> str:
    """A unique 6-digit code. Avoids leading-zero ambiguity by allowing the full range
    and zero-padding; collisions are retried."""
    for _ in range(50):
        code = f"{secrets.randbelow(1_000_000):06d}"
        if db.get(models.ActivationCode, code) is None:
            return code
    raise RuntimeError("Could not allocate a unique activation code")


def create_account(
    db: Session,
    *,
    tier: str = "free",
    senior_display_name: str = "Mom",
    stripe_customer_id: str | None = None,
    stripe_subscription_id: str | None = None,
) -> models.Account:
    account = models.Account(
        id=_new_id("acct"),
        tier=tier,
        senior_display_name=senior_display_name,
        caregiver_api_key=_new_id("cgk", 16),
        stripe_customer_id=stripe_customer_id,
        stripe_subscription_id=stripe_subscription_id,
    )
    db.add(account)
    db.flush()  # assign before creating the code row

    code = models.ActivationCode(code=generate_activation_code(db), account_id=account.id)
    db.add(code)
    db.commit()
    db.refresh(account)
    return account


def account_for_api_key(db: Session, api_key: str) -> models.Account | None:
    return (
        db.query(models.Account)
        .filter(models.Account.caregiver_api_key == api_key)
        .one_or_none()
    )
