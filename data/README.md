# Data Contract — Senior Directory v1.0

This directory holds the **canonical, shared data contract** consumed identically by:

- the **FastAPI backend** (serves the directory + builds activation payloads), and
- the **SwiftUI app** (renders the directory, caches the activation payload offline).

Treat everything here as the single source of truth. The backend and app should
deserialize against these schemas — do not redefine the shapes independently.

## Files

| File | Purpose |
|------|---------|
| `brands.json` | The 50 hardcoded national brands (the safe directory). |
| `schema/brand.schema.json` | JSON Schema for one brand entry. |
| `schema/activation_payload.schema.json` | JSON Schema for `GET /activate/{code}` — the per-senior config cached on device. |
| `schema/activation_payload.example.json` | A worked example payload for the backend/app to test against. |

## ⚠️ Numbers are UNVERIFIED SEED DATA

**Every phone number and brand color in `brands.json` is development seed data and
MUST be human-verified before any production release.** This is not boilerplate — it
is the core safety/liability control for this product:

- The moment the app displays a number, we assume a duty of care. A single wrong or
  stale number that routes a senior to a scammer is the worst possible failure mode
  and a direct legal exposure.
- Each entry carries a `verification` block. An entry is **not shippable** until its
  status moves from `unverified_seed` → `verified`, with `source`, `verified_on`, and
  `verified_by` filled in against the brand's `official_support_url`.
- Do **not** market the directory as "verified" or "un-spoofable" until this pass is
  complete. Use "spoof-resistant" until then.
- A scheduled freshness job should re-check verified numbers and set `flagged_stale`
  on drift; the app must hide `flagged_stale` entries.

## Design notes baked into the schema

### `support_type` — brands with NO phone support
Several of the most-impersonated brands (Roku, Google, Facebook/Meta, Instagram,
Zelle, Spotify, and others) offer **no customer-support phone line at all** — which is
exactly why scammers can sell fake "support numbers" for them.

For these, `support_type` is `"online_only"` and `phone` is `null`. The app must
**not** dial; instead it shows the entry's `safety_warning`, e.g.
*"This company has no support phone line — anyone who gives you one is a scammer."*
This turns the absence of a number into the most protective screen in the app.

### Activation payload — the two adoption features
The activation payload (fetched once, then cached) carries two v1 additions designed
to beat the senior-adoption problem:

- **`emergency_contact` (Feature #2 — "Call My Person"):** a caregiver-configured
  panic-button target. Always-visible large button that dials the caregiver directly
  (never 911). Gives the senior a daily reason to open the app.
- **`custom_contacts` (Feature #15 — pre-loaded contacts):** the caregiver pre-loads
  Mom's doctor/pharmacy/bank during web signup, so the app is useful on first open
  with no empty state.

### App Store compliance
The payload intentionally contains **no pricing, plan names, or upgrade copy**. `tier`
and `limits` exist only to cap custom-contact count. When the free list is full, the
app shows a neutral "list full" state — never a paywall — to stay within App Store
guideline 3.1.3 (purchases happen only on the web).

## Validation

```bash
# from repo root
python data/validate.py
```

This checks that `brands.json` parses, has exactly 50 brands, every entry validates
against `brand.schema.json`, categories are known, `online_only` brands have null
phones, `phone` brands have E.164 numbers, ids are unique, and the example activation
payload validates against its schema.
