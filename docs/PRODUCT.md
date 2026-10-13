# Product Notes — positioning, risks, roadmap

## Positioning
This is **not** "a directory app." It's **a caregiver-managed safety service for
seniors, where the verified directory is the V1 hook.** The durable business is the
caregiver funnel + remote management + trusted curation; the directory alone is a
feature, not a moat.

## Why it's worth building (validation)
- Older Americans' reported fraud losses hit **$2.4B in 2024** (~4x since 2020); FTC's
  true-cost estimate runs as high as **$81.5B**. Tech-support scams alone ≈ **$159M/yr**.
- The specific vector — scammers buying Google "Sponsored"/click-to-call ads that
  impersonate support lines — is documented and growing (Google issued advisories in
  May and Nov 2025). The standard official advice ("don't use a search engine to find a
  support number") is literally this product's one sentence.

## Top risks (and how the build addresses them)
| Risk | Mitigation in this codebase / roadmap |
|---|---|
| **Adoption** — seniors reflexively Google; an app they must *open* fights muscle memory | Panic button (#2) + pre-loaded contacts (#15) give daily utility and a non-empty first launch. Roadmap: passive intercept-layer (#1, #3). |
| **Liability** — one wrong/stale number routes a senior to a scammer | `verification` block on every brand; `unverified_seed` → `verified` gate; `flagged_stale` hidden by API + app. "un-spoofable" softened to "spoof-resistant". |
| **Thin moat** — a list of 50 numbers is trivially copyable | Defensibility = caregiver funnel + trusted curation + provenance, not the list. |
| **Integrity** — tampered cache / MITM | Ed25519-signed payloads verified on device. |

## Suite roadmap (features to round it out)
Compliance throughline: everything touching money/tiers stays on the **web/caregiver**
side; the senior binary stays a clean utility (App Store 3.1.3).

**V1 (this repo):** directory + JIT warnings + native dial + panic button (#2) +
pre-loaded contacts (#15).

**V1.1 — turns "a list" into "a service":**
- **#1 "Is this number real?" reverse-checker** — paste a number, get
  ✅ official / ⚠️ not in directory. The passive-gap killer; meets the senior at the
  moment of doubt.
- **#7 remote management console** (caregiver app/web) — core lock-in.
- **#11 number provenance** shown in-app ("confirmed from official site, [date]").
- **#4 photo-based local contacts**, **#5 voice/large-text + read-aloud**.

**V2 — recurring-revenue justification:**
- **#3 incoming-call sanity card** (CallKit) — edges into the Hiya/Nomorobo intercept space.
- **#8 peace-of-mind activity digest**, **#9 risky-behavior alerts** to the caregiver.
- **#10 multi-senior / family plan**, **#12 automated number-freshness monitoring**,
  **#13 caregiver-flagged corrections**.

## Future exploration — email scam protection (not scoped for v1)
The same "trusted, curated, can't-be-spoofed" philosophy can extend from phone numbers
to email, **without** turning the app into a spam filter (which AI screeners already do
well). Concepts, in rough order of fit:

1. **Sender allow-list / "Known Senders" lens.** Caregiver curates the brands/people the
   senior actually does business with; an app companion (or a simple forwarding rule)
   flags anything *outside* that set as "not someone you know." Mirrors the directory
   model: safety from a small trusted set, not from blocking an infinite bad set.
2. **"Is this email real?" checker.** Senior forwards/screenshots a suspicious email;
   we check the sender domain against the same verified-brand registry that backs the
   directory (e.g. "real Chase email comes from `chase.com`, this came from
   `chase-secure-alerts.com`"). Reuses the brand dataset — high leverage.
3. **Domain-impersonation lookups** (look-alike/typosquat detection) and surfacing
   email-auth failures (SPF/DKIM/DMARC) in plain language: "This claims to be PayPal but
   PayPal's servers didn't actually send it."
4. **Category-tailored email warnings**, reusing the existing `safety_warning` content
   ("your bank will never email you a link to 'verify your account'").
5. **Caregiver visibility loop:** the senior taps "this looks scary" → caregiver gets a
   heads-up — same trust/retention engine proposed for calls.

Heaviest lift is integration (no clean offline hook into Mail like there is into the
dialer); lightest valuable start is **#2**, because it reuses the verified-brand data we
already maintain. Worth a spike, not a v1 commitment.
