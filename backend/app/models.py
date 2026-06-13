"""Database models.

A Master Account is created by the Stripe webhook after web checkout. Each account
has exactly one 6-digit activation code, an optional emergency contact ("Call My
Person"), and a set of caregiver-managed custom contacts. No billing PII is stored
on rows that get serialized to the device.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # acct_…
    tier: Mapped[str] = mapped_column(String, default="free")  # free | premium
    senior_display_name: Mapped[str] = mapped_column(String, default="Mom")

    # Caregiver API auth (returned once at creation; used by the web dashboard).
    caregiver_api_key: Mapped[str] = mapped_column(String, index=True)

    # Billing linkage (never serialized to device).
    stripe_customer_id: Mapped[str | None] = mapped_column(String, nullable=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    activation_code: Mapped["ActivationCode"] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )
    emergency_contact: Mapped["EmergencyContact | None"] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )
    custom_contacts: Mapped[list["CustomContact"]] = relationship(
        back_populates="account", cascade="all, delete-orphan", order_by="CustomContact.created_at"
    )

    @property
    def max_custom_contacts(self) -> int | None:
        from .config import get_settings

        return None if self.tier == "premium" else get_settings().free_tier_max_custom_contacts


class ActivationCode(Base):
    __tablename__ = "activation_codes"

    code: Mapped[str] = mapped_column(String(6), primary_key=True)  # 6 digits
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    activated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fetch_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    account: Mapped[Account] = relationship(back_populates="activation_code")


class EmergencyContact(Base):
    """Feature #2 — the 'Call My Person' panic-button target."""

    __tablename__ = "emergency_contacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True, unique=True)
    name: Mapped[str] = mapped_column(String)
    phone: Mapped[str] = mapped_column(String)  # E.164
    phone_display: Mapped[str] = mapped_column(String)
    relationship_label: Mapped[str] = mapped_column(String)
    photo_url: Mapped[str | None] = mapped_column(String, nullable=True)

    account: Mapped[Account] = relationship(back_populates="emergency_contact")


class CustomContact(Base):
    """Feature #15 — caregiver-managed local contacts pre-loaded at signup."""

    __tablename__ = "custom_contacts"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # cc_…
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    phone: Mapped[str] = mapped_column(String)  # E.164
    phone_display: Mapped[str] = mapped_column(String)
    category: Mapped[str] = mapped_column(String)
    photo_url: Mapped[str | None] = mapped_column(String, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    account: Mapped[Account] = relationship(back_populates="custom_contacts")
