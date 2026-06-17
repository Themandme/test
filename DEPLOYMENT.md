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

## Database migrations (Alembic)
Alembic is wired up (`backend/alembic.ini`, `backend/migrations/`). In **production**,
`create_all` is disabled — the schema is owned by migrations, run as a deploy step:

```bash
cd backend
alembic upgrade head     # apply migrations before starting the app
```

When you change a model, generate and review a migration:

```bash
alembic revision --autogenerate -m "describe change"
# review the generated file in migrations/versions/, then commit it
alembic upgrade head
```

CI runs `alembic upgrade head` + `alembic check`, so a model change without a matching
migration fails the build. (In dev/test, `create_all` still builds the schema for speed.)
For multi-instance deploys, run migrations as a **single release job**, not per-instance,
to avoid concurrent-migration races.

## Rate limiting at scale
- Set **`REDIS_URL`** (e.g. `redis://host:6379/0`) so the in-app limiter uses the shared
  Redis backend — limits are then exact across every worker and instance (without it,
  each process counts independently, so the effective limit is ~N×). Redis outages fail
  open (degrade protection, don't break the API).
- Also add **rate limiting at the edge** for `/v1/activate/*` (CDN/WAF, e.g. Cloudflare)
  as a pre-app backstop against enumeration.

## Edge hardening (do at the load balancer / CDN)
- **TLS termination + HSTS** in front of the app.
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
