# Phone Number Verification — process & status

A wrong customer-service number in this app could route a senior straight to a scammer.
So number verification is a **release gate**, not a nicety. This file defines the process
and tracks status.

## Current status: ❌ NONE VERIFIED

All 50 brands are `verification.status = "unverified_seed"`. The numbers are plausible,
widely-published values entered as development seed data — they have **not** been
confirmed against each brand's official page. The directory must **not** be marketed as
"verified" (use "spoof-resistant") until this gate is cleared.

> Note: this pass could not be run in the build sandbox — the official brand domains
> bot-block all automated fetches (HTTP 403 to both WebFetch and `curl` from datacenter
> IPs). Run the tooling below from a normal network (a developer machine, or CI with
> browser-grade egress).

## Two ways to verify

### 1. Automated first pass — `verify_numbers.py`
Reads each brand's official page and compares it to `brands.json`.

```bash
python data/verify_numbers.py             # report only
python data/verify_numbers.py --write     # flip CONFIRMED entries to status=verified
```

Per-brand outcomes:

| Status | Meaning | Action |
|---|---|---|
| `CONFIRMED` | seed number found on the official page | auto-set to `verified` with `--write` |
| `DISCREPANCY` | official page shows a *different* prominent number | **human decides** — update the number, don't auto-trust |
| `NOT_FOUND` | no phone number on the page | human research |
| `OK_ONLINE_ONLY` | online_only brand, no phone found (consistent) | leave as-is |
| `REVIEW_HAS_PHONE` | online_only brand now shows a phone | re-classify? |
| `FETCH_BLOCKED` | page unreachable (bot wall) | re-run from a real network |

**Tool-confirmed is not the final word.** Regex can match a number that's on the page
for another reason, so a CONFIRMED still gets a human spot-check before launch.

### 2. Human sign-off worksheet (authoritative)
Generate a fillable CSV, then a reviewer confirms each entry against the official site:

```bash
python data/verify_numbers.py --worksheet > verification_worksheet.csv
```

For each brand the reviewer:
1. Opens the brand's `official_support_url` in a browser.
2. Finds the official customer-service number (or confirms there is **no** phone line).
3. Records the number, whether it matches the seed, their initials, and the date.
4. Updates `brands.json`: set `verification` to
   `{ "status": "verified", "source": "<exact page URL>", "verified_on": "<YYYY-MM-DD>", "verified_by": "<initials>" }`
   and correct the `phone`/`phone_display` if it differed.

## Acceptance criteria (release gate)
- [ ] Every `phone` brand: `verification.status == "verified"` with a real `source`, `verified_on`, `verified_by`.
- [ ] Every `online_only` brand: confirmed to have **no** official phone line, signed off the same way.
- [ ] `python data/validate.py` passes.
- [ ] Any `DISCREPANCY` resolved (number corrected or seed confirmed).
- [ ] Re-verification cadence agreed (numbers drift) — see the freshness job in the roadmap.

## The 10 online-only brands (special care)
These intentionally have **no** phone support, which is exactly why scammers sell fake
"support numbers" for them. Verification here means confirming the *absence* of an
official line: `roku, hulu, max, paramount_plus, peacock, spotify, google, meta_facebook,
instagram, zelle`.
