# Security & Production Safety

Senior Directory holds elderly users' trusted contacts and is the line of defense against
phone-support impersonation fraud. Its security posture matters more than a typical app.
This documents the threat model, the protections in place, and what remains.

## What we protect
- **Seniors' PII**: the activation payload contains their custom contacts (doctor,
  pharmacy, bank) and the emergency "Call My Person" number.
- **Directory integrity**: the 50 official numbers must not be tamperable — a swapped
  number could route a senior to a scammer.
- **Billing**: handled entirely by Stripe; the backend stores no card data.

## Threats & mitigations

| Threat | Mitigation | Where |
|---|---|---|
| **Activation-code enumeration** (6-digit code → harvest others' PII) | Aggressive per-IP rate limit + global circuit breaker on `/v1/activate`; `Retry-After`. Edge rate limiting required at scale. | `app/ratelimit.py`, `main.py` |
| **Payload tampering / MITM** | Ed25519-signed activation payloads; the app verifies before trusting. **Stable** key required in prod (startup fails without it). | `app/signing.py`, `config.validate_for_runtime` |
| **Stolen caregiver API key (DB leak)** | Keys are stored as SHA-256 hashes; plaintext shown once at creation. | `app/accounts.py` |
| **Forged Stripe webhooks** | Signature verified with `STRIPE_WEBHOOK_SECRET` (required in prod). | `app/stripe_service.py` |
| **Misconfig at deploy** | Fail-closed startup: prod refuses to boot without signing key, Postgres, webhook secret, dev-endpoints-off, https CORS. | `config.validate_for_runtime` |
| **Dev backdoor in prod** | `/v1/dev/accounts` is disabled in production and whenever Stripe is configured. | `config.dev_endpoints_enabled` |
| **Clickjacking / sniffing / cache leakage** | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cache-Control: no-store`, HSTS in prod. | `main.py` |
| **Over-permissive CORS** | Origins restricted to the web funnel (no `*`); methods/headers scoped. | `main.py`, `config.cors_origins` |

## Known limitations / hardening backlog
- **Rate limiting backend.** Default is per-process (in-memory). Set `REDIS_URL` to use
  the shared Redis backend so limits are **exact across all workers and instances**
  (`RedisSlidingWindowLimiter`, atomic Lua sliding window, fails open if Redis is down).
  Edge rate limiting (Cloudflare/WAF) is still recommended as a pre-app backstop.
- **Activation codes are 6 digits** (product requirement for caregiver entry). Rate
  limiting is the primary defense; consider also: single-use-after-activation, device
  binding, short code TTL, and anomaly alerting on `act:global` trips.
- **No migrations yet** — production must adopt Alembic (see DEPLOYMENT.md); `create_all`
  is dev-only.
- **iOS ATS**: `NSAllowsLocalNetworking` is set so Debug can reach `http://localhost`.
  It only affects loopback/local hostnames, not remote traffic — Release talks to the
  prod API over HTTPS with full ATS — so it is safe to ship, but can be moved to a
  Debug-only config if preferred.
- **Number verification** is the outstanding *safety* gate (see `data/VERIFICATION.md`).

## Reporting a vulnerability
Email security@safe-numbers.app (placeholder) with details and steps to reproduce.
Please do not open public issues for security reports.
