# Web Checkout Funnel

The "Web Checkout First" half of the model: an influencer link → landing page → Stripe
Checkout (Apple Pay) → a **6-digit activation code** the caregiver enters in the app.
The mobile app never touches billing, which keeps it App-Store-compliant — pricing lives
only here on the web.

```
?ref=influencer → index.html → POST /v1/checkout/session
   → Stripe Checkout (or simulated) → success.html
   → GET /v1/checkout/result?session_id=… → shows the code
```

## Files
| File | Purpose |
|------|---------|
| `index.html` / `app.js` | Landing + pricing; captures `?ref=` and starts checkout. |
| `success.html` / `success.js` | Polls the backend and shows the activation code. |
| `styles.css` | Styling. |
| `config.js` | `API_BASE` + display prices — edit per environment. |

## Run locally (no Stripe needed)
The backend uses a **simulated checkout** when `STRIPE_API_KEY` is unset, so the whole
funnel works end-to-end offline:

```bash
# 1) backend
cd ../backend && uvicorn app.main:app --port 8000

# 2) web (static) — any static server on port 5173
cd ../web && python -m http.server 5173
```

Open <http://localhost:5173/?ref=demo>, click **Get started**, and you’ll land on the
success page with a real activation code (provisioned by the simulated checkout). Enter
that code in the iOS app (Debug build → `http://localhost:8000`).

## Going live with Stripe
1. Create two recurring Prices in Stripe ($4.99/mo, $29.99/yr) with Apple Pay enabled.
2. Set `STRIPE_API_KEY`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and
   `STRIPE_WEBHOOK_SECRET` in the backend env, and point a Stripe webhook at
   `POST /v1/checkout/session`’s host `…/v1/webhooks/stripe`.
3. Set `WEB_BASE_URL` and `config.js` `API_BASE` to your deployed URLs.
4. With a real key, `/v1/checkout/session` returns a Stripe Checkout URL; the success
   page resolves the code from the webhook (or on-demand from the session).

The funnel records the influencer `ref` on the account for affiliate attribution.
