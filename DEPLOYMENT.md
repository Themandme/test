# Deployment & Production Readiness

How to deploy the backend safely, and the gate that must be cleared before wide release.

## Backend (container)

```bash
# build (from repo root — the image copies backend/ and data/)
docker build -f backend/Dockerfile -t senior-directory-api .

# run with production env
docker run --env-file backend/.env.production -p 8000:8000 senior-directory-api
```

The image runs Gunicorn + Uvicorn workers as a non-root user with a healthcheck. The app
**refuses to start** if production safety checks fail (missing signing key, SQLite,
missing webhook secret, dev endpoints on, non-https CORS) — see `config.validate_for_runtime`.

## Required production configuration
Copy `backend/.env.production.example` and fill real secrets (store them in your platform's
secret manager, not in the image):

1. `ENVIRONMENT=production`
2. `SIGNING_KEY_SEED_B64` — generate once and keep stable across all instances:
   ```bash
   python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"
   ```
   Rotating this invalidates every cached payload's signature, so treat it as long-lived.
3. `DATABASE_URL` — Postgres (`postgresql+psycopg://…`). SQLite is rejected in prod.
4. `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`.
5. `WEB_BASE_URL` (https) and any `EXTRA_CORS_ORIGINS`.
6. `ENABLE_DEV_ENDPOINTS=false`.

## Database migrations (required before launch)
The app currently uses SQLAlchemy `create_all`, which **does not migrate** existing
schemas (this is why a stale dev DB 500s after a model change). Before production:

```bash
pip install alembic
alembic init migrations          # then point env.py at app.database.Base + DATABASE_URL
alembic revision --autogenerate -m "initial"
alembic upgrade head             # run on deploy, before starting the app
```

Until Alembic is wired up, schema changes require a fresh DB — never acceptable in prod.

## Edge hardening (do at the load balancer / CDN)
- **TLS termination + HSTS** in front of the app.
- **Rate limiting at the edge** for `/v1/activate/*` — the in-app limiter is per-process;
  a CDN/WAF rule (e.g. Cloudflare) gives shared, pre-app protection against enumeration.
- Set `FORWARDED_ALLOW_IPS` to your proxy/LB CIDR so client IPs are trusted correctly.
- Restrict the Stripe webhook path to Stripe's IPs if your platform supports it.

## Stripe setup
1. Create two recurring Prices ($4.99/mo, $29.99/yr) with Apple Pay enabled.
2. Register a webhook → `https://<api>/v1/webhooks/stripe`, copy the signing secret.
3. Point `web/config.js` `API_BASE` and `WEB_BASE_URL` at the deployed hosts.

## Web funnel
Static files in `web/` — host on any static/CDN origin (S3+CloudFront, Netlify, etc.).
Set `web/config.js` `API_BASE` to the API URL.

## Pre-launch gate
- [ ] All production env vars set; `validate_for_runtime` passes (app boots).
- [ ] Postgres + Alembic migrations applied.
- [ ] Edge TLS + rate limiting on `/v1/activate/*`.
- [ ] **All 50 numbers verified** (`data/VERIFICATION.md`) — the safety gate.
- [ ] App Store 3.1.3 review: no pricing/purchase strings in the iOS binary.
- [ ] Backend tests green (`pytest`); CI green.
- [ ] Privacy policy + data-handling disclosure published.
- [ ] Secret manager holds the signing seed + Stripe keys; rotation runbook written.
```
