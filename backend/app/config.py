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

    # Storage
    database_url: str = "sqlite:///./senior_directory.db"
    brands_path: Path = DEFAULT_BRANDS_PATH

    # Stripe
    stripe_api_key: str = ""
    stripe_webhook_secret: str = ""
    # Stripe price IDs mapped to entitlement tiers.
    stripe_premium_price_ids: str = ""  # comma-separated price_… ids that grant premium

    # Activation payload signing (Ed25519). Base64-encoded 32-byte seed.
    # If empty, a development key is generated at startup (NOT for production).
    signing_key_seed_b64: str = ""

    # Free-tier limit on caregiver-managed local contacts.
    free_tier_max_custom_contacts: int = 3

    def premium_price_id_set(self) -> set[str]:
        return {p.strip() for p in self.stripe_premium_price_ids.split(",") if p.strip()}

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
