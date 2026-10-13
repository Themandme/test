# Senior Directory — v1.0

An un-spoofable*, senior-friendly smartphone directory that replaces risky Google
searches for customer-service numbers — protecting elderly users from "Sponsored Ad"
support-line fraud. Seniors tap a company, read a tailored safety warning, and dial an
official number. The app runs **100% offline** after a one-time activation.

<sub>*Marketed as **spoof-resistant** until the directory completes human number
verification — see `data/README.md`.</sub>

## Repository layout

| Path | What it is | Status |
|------|------------|--------|
| `data/` | The shared data contract: 50-brand directory + JSON Schemas consumed by both backend and app. | ✅ built, validated |
| `backend/` | FastAPI service: serves the directory, signs activation payloads, handles the Stripe funnel. | ✅ built, 11 tests passing |
| `ios/` | SwiftUI app: activation, offline directory, search, JIT safety prompts, native dialing. | ✅ source complete (build in Xcode) |
| `docs/` | Architecture, funnel, and product notes. | ✅ |

## How it works (end to end)

```
Caregiver clicks influencer link → web landing → Stripe Checkout (Apple Pay)
   → backend Stripe webhook provisions a Master Account + 6-digit activation code
   → caregiver enters code in the app
   → app fetches the signed activation payload ONCE, verifies its Ed25519 signature,
     caches it in SQLite, and runs fully offline thereafter
Senior opens the app → searches the local directory → taps a company
   → 3-second Just-In-Time safety warning → native dialer
```

The mobile app contains **zero** pricing, plans, or purchase links — purchases happen
only on the web — which keeps it within App Store Review Guideline 3.1.3.

## Tiers
- **Free:** all 50 national brands + up to 3 caregiver-managed local contacts.
- **Premium ($4.99/mo or $29.99/yr):** all 50 brands + unlimited local contacts.

Tier is set by the Stripe price at checkout and enforced server-side; the app only ever
sees a neutral contact limit, never a paywall.

## Quick start (backend)

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload     # http://127.0.0.1:8000/docs
python -m pytest -q               # 11 tests
```

Validate the shared data contract:

```bash
python data/validate.py           # 50 brands, schemas, invariants
```

## Documentation
- `docs/ARCHITECTURE.md` — components, data flow, security model.
- `docs/PRODUCT.md` — positioning, risk register, the suite roadmap.
- `CHANGELOG.md` — what was built, in order.
- `data/README.md` — the data contract + the number-verification discipline.
- `backend/README.md`, `ios/README.md` — per-layer details.
