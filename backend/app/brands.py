"""Loads and serves the hardcoded national-brand directory from data/brands.json.

The file is the shared source of truth; we cache it in memory at startup. The app
fetches this once and stores it locally so the directory works fully offline.
"""
from __future__ import annotations

import json
from functools import lru_cache

from .config import get_settings
from .schemas import Brand, BrandsResponse


@lru_cache
def load_brands() -> BrandsResponse:
    path = get_settings().brands_path
    doc = json.loads(path.read_text())
    brands = [Brand.model_validate(b) for b in doc["brands"]]

    # Safety net: never serve a number flagged stale by the freshness job.
    visible = [b for b in brands if b.verification.status != "flagged_stale"]

    return BrandsResponse(
        schema_version=doc["_meta"]["schema_version"],
        count=len(visible),
        categories=doc["categories"],
        brands=visible,
    )
