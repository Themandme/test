#!/usr/bin/env python3
"""Validate the shared data contract.

Checks brands.json and the example activation payload against the JSON Schemas
and the product invariants. Exits non-zero on any failure so it can gate CI.

Uses `jsonschema` if installed; otherwise falls back to built-in invariant checks
so it still runs in a bare environment.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent
SCHEMA_DIR = DATA_DIR / "schema"

E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
SLUG = re.compile(r"^[a-z0-9_]+$")

errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def load(path: Path):
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        err(f"{path.name}: invalid JSON — {e}")
        return None


def try_schema_validation(instance, schema_path: Path, label: str) -> None:
    try:
        import jsonschema  # type: ignore
    except ImportError:
        print(f"  (jsonschema not installed — skipping formal schema check for {label})")
        return
    schema = load(schema_path)
    if schema is None:
        return
    validator = jsonschema.Draft202012Validator(schema)
    for e in sorted(validator.iter_errors(instance), key=lambda e: e.path):
        loc = "/".join(str(p) for p in e.path) or "<root>"
        err(f"{label}: schema error at {loc}: {e.message}")


def main() -> int:
    brands_doc = load(DATA_DIR / "brands.json")
    if brands_doc is None:
        print_summary()
        return 1

    categories = set(brands_doc.get("categories", []))
    brands = brands_doc.get("brands", [])

    if len(brands) != 50:
        err(f"brands.json: expected exactly 50 brands, found {len(brands)}")

    seen_ids: set[str] = set()
    brand_schema = SCHEMA_DIR / "brand.schema.json"

    for b in brands:
        bid = b.get("id", "<missing id>")

        if not SLUG.match(str(b.get("id", ""))):
            err(f"{bid}: id must match ^[a-z0-9_]+$")
        if bid in seen_ids:
            err(f"{bid}: duplicate id")
        seen_ids.add(bid)

        if b.get("category") not in categories:
            err(f"{bid}: unknown category '{b.get('category')}'")

        if not HEX.match(str(b.get("brand_color_hex", ""))):
            err(f"{bid}: bad brand_color_hex '{b.get('brand_color_hex')}'")
        if not HEX.match(str(b.get("text_color_hex", ""))):
            err(f"{bid}: bad text_color_hex '{b.get('text_color_hex')}'")

        if not b.get("safety_warning"):
            err(f"{bid}: empty safety_warning")

        st = b.get("support_type")
        if st == "online_only":
            if b.get("phone") is not None or b.get("phone_display") is not None:
                err(f"{bid}: online_only brands must have null phone and phone_display")
        elif st == "phone":
            if not E164.match(str(b.get("phone", ""))):
                err(f"{bid}: phone must be E.164, got '{b.get('phone')}'")
            if not b.get("phone_display"):
                err(f"{bid}: phone brands must have a phone_display")
        else:
            err(f"{bid}: support_type must be 'phone' or 'online_only', got '{st}'")

        v = b.get("verification", {})
        if v.get("status") not in {"unverified_seed", "web_corroborated", "verified", "flagged_stale"}:
            err(f"{bid}: bad verification.status '{v.get('status')}'")

        try_schema_validation(b, brand_schema, f"brand[{bid}]")

    # Activation payload example
    example = load(SCHEMA_DIR / "activation_payload.example.json")
    if example is not None:
        try_schema_validation(
            example, SCHEMA_DIR / "activation_payload.schema.json", "activation_payload.example"
        )
        limit = example.get("limits", {}).get("max_custom_contacts")
        if isinstance(limit, int) and len(example.get("custom_contacts", [])) > limit:
            err("activation_payload.example: custom_contacts exceeds max_custom_contacts")

    print_summary()
    return 1 if errors else 0


def print_summary() -> None:
    if errors:
        print(f"\n❌ {len(errors)} problem(s) found:\n")
        for e in errors:
            print(f"  - {e}")
    else:
        print("\n✅ Data contract valid: 50 brands, schemas OK, invariants hold.")


if __name__ == "__main__":
    sys.exit(main())
