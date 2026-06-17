# Senior Directory — Backend (FastAPI)

Serves the hardcoded national-brand directory and issues **signed, offline-cacheable
activation payloads** for senior devices. Account creation is driven by **Stripe
webhooks** from the web checkout funnel — the mobile app never touches billing, which
keeps it within App Store guideline 3.1.3.

## Run it

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in Stripe keys when ready
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000/docs for the interactive API.

## Endpoints

### Consumed by the SwiftUI app
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/brands` | The 50-brand directory (from `data/brands.json`). |
| `GET` | `/v1/signing-key` | Ed25519 public key; the app verifies payload signatures with it. |
| `GET` | `/v1/activate/{code}` | The signed `ActivationPayload`. Fetched **once**, then cached offline. |

### Funnel
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/webhooks/stripe` | After web checkout, provisions a Master Account + 6-digit code and maps the price to a tier. Idempotent per subscription. |

### Caregiver dashboard (web) — `X-API-Key` auth
| Method | Path | Purpose |
|--------|------|---------|
| `GET/PUT` | `/v1/account/emergency-contact` | The "Call My Person" panic target (Feature #2). |
| `GET/POST/DELETE` | `/v1/account/contacts` | Pre-loaded local contacts (Feature #15). Free tier capped at 3; premium unlimited. |

### Dev only (auto-disabled once `STRIPE_WEBHOOK_SECRET` is set)
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/dev/accounts` | Provision an account without Stripe, for local end-to-end testing. |

## How the funnel works

```
influencer link → web landing → Stripe Checkout (Apple Pay)
      → checkout.session.completed webhook
      → create Account + 6-digit ActivationCode + caregiver_api_key
      → caregiver sees code on success page / email
      → caregiver enters code in the app → GET /v1/activate/{code}
      → app caches the signed payload and runs 100% offline
```

## Security / integrity

- **Signed payloads (Ed25519).** Every activation payload is signed over a canonical
  string `account_id|tier|issued_at|sha256(contacts)`. The app verifies it with the
  public key, so a tampered cache or MITM cannot silently inject a scammer's number.
  This is the technical basis for the "spoof-resistant" claim.
- **No billing PII on device.** Stripe customer/subscription ids stay server-side and
  are never serialized into the payload.
- **Tier limits enforced server-side** at contact-creation time, then mirrored in the
  payload's `limits` so the offline app can show a neutral "list full" state — never a
  paywall.

## Web checkout funnel

`POST /v1/checkout/session` + `GET /v1/checkout/result` power the web funnel (see
`../web`). With `STRIPE_API_KEY` set they use real Stripe Checkout; unset, a **simulated**
checkout provisions an account immediately so the funnel works end-to-end without keys.

> Dev DB note: SQLite `create_all` does not run migrations. After a model change (e.g.
> the checkout columns), delete `backend/senior_directory.db` so it's recreated — an old
> file will 500 with "no such column". Production should use Postgres + Alembic.

## Tests

```bash
cd backend && python -m pytest -q
```

Covers the directory invariants, activation + signature verification, caregiver
contact management with tier limits, and Stripe webhook provisioning/idempotency/
downgrade. (11 tests.)

## Layout

```
backend/app/
  config.py          settings (env), signing-key loading, brands path
  database.py        SQLAlchemy engine/session (SQLite default)
  models.py          Account, ActivationCode, EmergencyContact, CustomContact
  schemas.py         Pydantic API models — mirror data/schema/*.json
  brands.py          loads + serves data/brands.json (hides flagged_stale)
  accounts.py        account / 6-digit code / api-key generation
  activation.py      builds the signed ActivationPayload
  signing.py         Ed25519 sign/verify of payloads
  stripe_service.py  webhook event handling (provision / update / downgrade)
  main.py            FastAPI routes
```
