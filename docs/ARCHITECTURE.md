# Architecture

## Components

```
┌─────────────────┐     Stripe webhook      ┌──────────────────────────┐
│  Web checkout   │ ──────────────────────▶ │       FastAPI backend     │
│ (Stripe + Apple │                         │  • /v1/brands (directory) │
│  Pay) — funnel  │   6-digit code ◀─────── │  • /v1/activate/{code}    │
└─────────────────┘                         │    (Ed25519-signed)       │
        ▲                                    │  • Stripe provisioning   │
        │ influencer link                    │  • caregiver dashboard   │
   Caregiver                                 └──────────────┬───────────┘
        │ enters code                                       │ signed payload
        ▼                                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         iOS app (SwiftUI)                              │
│  Activation → verify signature → cache in SQLite → run 100% offline   │
│  Directory grid · local search · JIT safety prompt · native dialer    │
│  Panic button (#2) · pre-loaded contacts (#15)                        │
└──────────────────────────────────────────────────────────────────────┘
```

## Shared data contract (`data/`)
`brands.json` + JSON Schemas are the single source of truth. The backend serves them and
the app bundles an identical copy (`ios/.../Resources/brands.json`) so the directory
works on first launch with no network. `validate.py` gates the dataset in CI.

## Data flow

1. **Provisioning (server):** `checkout.session.completed` → `Account` + 6-digit
   `ActivationCode` + `caregiver_api_key`; the Stripe price maps to `tier`. Idempotent
   per subscription; cancellation downgrades to `free`.
2. **Caregiver setup (web):** dashboard API (`X-API-Key`) sets the emergency contact
   ("Call My Person") and pre-loads custom contacts, capped by tier.
3. **Activation (app):** `GET /v1/activate/{code}` returns an `ActivationPayload`. The
   app fetches the Ed25519 public key, verifies the signature, and caches the payload +
   directory in SQLite (GRDB).
4. **Offline use:** search and dialing read only the local cache. A best-effort brand
   refresh runs when online but is never required.

## Security / integrity model

- **Signed payloads (Ed25519).** Canonical string
  `account_id | tier | issued_at | sha256(contacts_json)`, where `contacts_json` is a
  compact, sorted-key, `ensure_ascii` JSON of the contacts. The app reproduces this
  byte-for-byte (`SignatureVerifier`) and rejects anything that doesn't verify — so a
  tampered cache or man-in-the-middle cannot inject a scammer's number. A cross-language
  test pins the Swift/Python canonical forms together.
- **No phone support = strongest screen.** 10 of the 50 brands (Roku, Google, Meta,
  Instagram, Zelle, Spotify, Hulu, Max, Paramount+, Peacock) are `online_only` with a
  null phone; the app refuses to dial and warns that any "support number" is a scam.
- **Number verification discipline.** Every brand carries a `verification` block; numbers
  ship as `unverified_seed` until a human confirms them against the official source. A
  freshness job sets `flagged_stale`, which both the API and the app hide. This is the
  basis for the "spoof-resistant" claim and the main liability control.
- **No billing PII on device.** Stripe ids stay server-side; the payload carries only
  what the senior UI needs.
- **App Store 3.1.3.** No pricing/plan/upgrade copy in the binary; the free-tier limit
  renders as a neutral "list full" state.

## Why these choices
- **FastAPI + SQLite:** lightweight, deployment-ready, easy Stripe + Pydantic.
- **GRDB/SQLite on device:** scales to unlimited Premium contacts with fast local search,
  and stores the payload verbatim for re-verification.
- **Bundled seed + cache:** guarantees the directory is never blank, even offline on a
  brand-new install.
