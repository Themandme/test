"""Runtime configuration.

All secrets come from the environment (.env in dev). Nothing here is ever sent to
the mobile app except the public signing key.
"""
from __future__ import annotations

import base64
from functools import lru_cache
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo layout: <repo>/backend/app/config.py -> brands.json lives at <repo>/data/brands.json
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BRANDS_PATH = REPO_ROOT / "data" / "brands.json"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    # development | production. Production fails closed on missing secrets (see validate()).
    environment: str = "development"

    # Storage
    database_url: str = "sqlite:///./senior_directory.db"
    brands_path: Path = DEFAULT_BRANDS_PATH

    # Shared rate-limit store. Set to e.g. redis://host:6379/0 to make limits exact across
    # workers/instances; empty = per-process in-memory limiter.
    redis_url: str = ""

    # Error monitoring (optional). Set a Sentry DSN to enable; requires `pip install
    # sentry-sdk` (kept out of base requirements so it stays opt-in).
    sentry_dsn: str = ""

    # Abuse protection. Activation returns PII (a senior's contacts), and codes are only
    # 6 digits, so the activation endpoint is rate-limited hard to prevent enumeration.
    activation_rate_limit: int = 8        # requests …
    activation_rate_window_s: int = 60    # … per IP per window
    activation_global_limit: int = 240    # circuit breaker across all IPs per window
    api_rate_limit: int = 120             # general per-IP limit for other endpoints
    api_rate_window_s: int = 60

    # Explicitly enable the unauthenticated dev provisioning endpoint. Forced off in prod.
    enable_dev_endpoints: bool = True

    # Extra comma-separated CORS origins (beyond web_base_url).
    extra_cors_origins: str = ""

    # Stripe
    stripe_api_key: str = ""
    stripe_webhook_secret: str = ""
    # Stripe price IDs mapped to entitlement tiers.
    stripe_premium_price_ids: str = ""  # comma-separated price_… ids that grant premium
    # Price IDs for the two web-checkout plans (both grant premium).
    stripe_price_monthly: str = ""
    stripe_price_yearly: str = ""

    # Public base URL of the web funnel (used for Stripe success/cancel redirects).
    web_base_url: str = "http://localhost:5173"

    # Activation payload signing (Ed25519). Base64-encoded 32-byte seed.
    # If empty, a development key is generated at startup (NOT for production).
    signing_key_seed_b64: str = ""

    # Free-tier limit on caregiver-managed local contacts.
    free_tier_max_custom_contacts: int = 3

    def premium_price_id_set(self) -> set[str]:
        ids = {p.strip() for p in self.stripe_premium_price_ids.split(",") if p.strip()}
        ids |= {p for p in (self.stripe_price_monthly, self.stripe_price_yearly) if p}
        return ids

    def price_id_for_plan(self, plan: str) -> str | None:
        return {"monthly": self.stripe_price_monthly, "yearly": self.stripe_price_yearly}.get(plan)

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.stripe_api_key)

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @property
    def dev_endpoints_enabled(self) -> bool:
        # Never in production, and never once Stripe billing is wired up.
        return self.enable_dev_endpoints and not self.is_production and not self.stripe_webhook_secret

    def cors_origins(self) -> list[str]:
        origins = {self.web_base_url}
        origins |= {o.strip() for o in self.extra_cors_origins.split(",") if o.strip()}
        if not self.is_production:
            origins |= {"http://localhost:5173", "http://127.0.0.1:5173"}
        return sorted(origins)

    def validate_for_runtime(self) -> list[str]:
        """Fail-closed checks. Returns a list of fatal problems (empty = OK)."""
        problems: list[str] = []
        if self.is_production:
            if not self.signing_key_seed_b64:
                problems.append("SIGNING_KEY_SEED_B64 is required in production (no ephemeral keys).")
            if self.database_url.startswith("sqlite"):
                problems.append("A real database (Postgres) is required in production, not SQLite.")
            if not self.stripe_webhook_secret:
                problems.append("STRIPE_WEBHOOK_SECRET is required in production to verify webhooks.")
            if self.enable_dev_endpoints:
                problems.append("ENABLE_DEV_ENDPOINTS must be false in production.")
            if any(o.startswith("http://") and "localhost" not in o and "127.0.0.1" not in o
                   for o in self.cors_origins()):
                problems.append("CORS origins must be https in production.")
        return problems

    def load_signing_key(self) -> Ed25519PrivateKey:
        if self.signing_key_seed_b64:
            seed = base64.b64decode(self.signing_key_seed_b64)
            return Ed25519PrivateKey.from_private_bytes(seed)
        # Dev fallback: ephemeral key. Stable within a process so the app can fetch
        # the public key and verify, but it rotates on restart — fine for local dev.
        return Ed25519PrivateKey.generate()


@lru_cache
def get_settings() -> Settings:
    return Settings()
