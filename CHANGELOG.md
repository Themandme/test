# Changelog

All notable changes to Senior Directory v1.0, in build order. Branch:
`claude/senior-directory-app-v1-oopv56`.

## [Unreleased]

### Caregiver dashboard — `web/dashboard.*` + backend
- Static web dashboard: caregiver signs in with their `cgk_…` key to manage the senior's
  account — activation code, plan + usage, the "Call My Person" emergency contact, and
  saved contacts (add/remove, Free-tier 3-cap enforced). Phones normalized to E.164.
- Backend: `GET/PUT /v1/account` (summary + rename senior). 4 new tests; suite 29 green.

### Android app — `android/` (Kotlin + Jetpack Compose)
- Full feature parity with iOS: activation → signed offline cache (SharedPreferences) →
  directory grid + local search → 3-second JIT safety prompt → native dialer
  (`ACTION_DIAL`) → panic button + caregiver pre-loaded contacts.
- Same data contract: bundles `data/brands.json` as an asset; models via
  kotlinx.serialization; thin OkHttp client for activation/refresh only.
- Ed25519 payload verification (BouncyCastle) with a canonical string that matches the
  backend and iOS **byte-for-byte** — pinned by a JUnit test against a backend-generated
  golden value.
- Debug → `http://10.0.2.2:8000` (emulator host alias), Release → prod HTTPS; cleartext
  scoped to dev hosts via network-security-config; backup disabled (PII).
- Gradle (Kotlin DSL) + version catalog; CI `android` job runs `assembleDebug` +
  `testDebugUnitTest`.

### Web checkout funnel — `web/` + backend
- Static funnel: `index.html` (landing + pricing, captures influencer `?ref=`),
  `success.html` (polls for and shows the 6-digit code), `config.js`/`styles.css`.
- Backend: `POST /v1/checkout/session` and `GET /v1/checkout/result` (`app/checkout.py`).
  Real Stripe Checkout when `STRIPE_API_KEY` is set; otherwise a **simulated** checkout
  provisions an account immediately so the funnel runs end-to-end with no keys.
- Account now stores `stripe_checkout_session_id` + `referral_ref` (affiliate
  attribution); webhook + result lookup both populate them. CORS added for the web origin.
- 4 funnel tests (simulated path); suite now 15 green. Verified end-to-end locally
  (checkout → activation code → `/v1/activate`).
- Dev note: SQLite `create_all` doesn't migrate; delete `backend/senior_directory.db`
  after a model change (the new columns) or checkout 500s on the old schema.

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

### CI
- `.github/workflows/ci.yml`: three jobs on every push/PR — **data-contract**
  (`validate.py`), **backend** (pytest on Ubuntu/Py3.11), and **iOS** (XcodeGen +
  `xcodebuild test` on a macOS runner, the first place the Swift actually compiles).
  Replaces the placeholder `blank.yml`. Concurrency-cancels superseded runs.

### Docs
- Top-level `README.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md` (validation, risk
  register, suite roadmap incl. a future email-scam-protection exploration), per-layer
  READMEs, and `data/README.md` (verification discipline).
