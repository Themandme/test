# Changelog

All notable changes to Senior Directory v1.0, in build order. Branch:
`claude/senior-directory-app-v1-oopv56`.

## [Unreleased]

### 1. Shared data contract — `data/`
- `brands.json`: the 50 most-impersonated national brands, each with an official number
  (E.164), signature corporate color + a contrast-checked text color, and a
  category-specific safety warning. 11 categories.
- Added `support_type`: 10 brands with **no phone support** (Roku, Google, Meta,
  Instagram, Zelle, Spotify, Hulu, Max, Paramount+, Peacock) carry a `null` phone so the
  app warns instead of dialing — turning the absence of a number into a protective screen.
- JSON Schemas (`schema/brand.schema.json`, `schema/activation_payload.schema.json`) as
  the single source of truth for both backend and app; worked example payload included.
- `verification` block on every brand enforces human number-verification before
  production; all numbers ship as `unverified_seed`. `validate.py` gates the dataset
  (50 entries, E.164, schema, invariants) — passing.
- Activation payload carries `emergency_contact` (Feature #2, "Call My Person" panic
  button) and pre-loaded `custom_contacts` (Feature #15) to beat senior adoption / empty
  first-launch.

### 2. Backend — `backend/` (FastAPI)
- `GET /v1/brands` serves the directory; hides `flagged_stale` entries.
- `GET /v1/activate/{code}` returns an **Ed25519-signed** `ActivationPayload` the app
  caches once and runs offline; signature covers `account|tier|issued_at|contacts hash`.
- `GET /v1/signing-key` exposes the public key for on-device verification.
- `POST /v1/webhooks/stripe` provisions a Master Account + 6-digit code, maps Stripe
  price → tier, idempotent per subscription, downgrades to free on cancel.
- Caregiver dashboard API (`X-API-Key`): manage emergency contact + custom contacts;
  free tier capped at 3, premium unlimited, enforced server-side.
- Dev-only provisioning endpoint (auto-disabled once Stripe is configured) for local
  end-to-end testing.
- **11 passing tests** (directory invariants, activation + signature verification, tier
  limits, webhook provisioning/idempotency/downgrade).
- Fixed: `issued_at` is signed and transmitted as the identical ISO string (no datetime
  serialization drift that would break verification).

### 3. iOS app — `ios/` (SwiftUI, iOS 17+)
- Offline-first: `AppState` loads from SQLite (GRDB); fresh installs seed the directory
  from a bundled `brands.json` so the 50 brands work with no network.
- Activation screen (6-digit code, no pricing — App Store 3.1.3); fetch → **verify
  signature** → cache.
- Directory: local-only search, brand grid as bold text on signature colors (no logos →
  trademark-safe), saved local contacts, and the "Call My Person" panic button.
- Just-In-Time safety prompt: full-screen, enforced 3-second read, then native dial via
  `tel:`. `online_only` brands show a "no phone support — any number is a scam" screen
  and never dial.
- `SignatureVerifier` reproduces the backend's canonical signing string byte-for-byte;
  `SignatureVerifierTests` pins the SHA-256 of the canonical contacts JSON to a
  backend-generated value (cross-language conformance).
- Note: builds in Xcode/macOS (SwiftUI/CryptoKit/UIKit); not compilable in the Linux
  sandbox. GRDB added via SPM.
- **XcodeGen manifest** (`ios/project.yml`) + `ios/bootstrap.sh` generate the project,
  resolve GRDB, and build/test in one command. Wires the bundled `brands.json` resource,
  an `Info.plist` with `API_BASE_URL` and the `tel` query scheme, and the test target +
  shared scheme. Generated `.xcodeproj`/`Info.plist` are gitignored.

### Docs
- Top-level `README.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md` (validation, risk
  register, suite roadmap incl. a future email-scam-protection exploration), per-layer
  READMEs, and `data/README.md` (verification discipline).
