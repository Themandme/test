#!/usr/bin/env python3
"""Verify the directory's phone numbers against each brand's OFFICIAL page.

Why this exists
---------------
Every number in brands.json ships as `unverified_seed`. For a fraud-protection app,
a wrong number is the worst failure mode, so a number may not be marketed as "verified"
until a human (or this tool, run against the real sites) has confirmed it against the
brand's own domain.

What it does
------------
For each brand it fetches `official_support_url` (falling back to `official_url`),
extracts phone candidates from `tel:` links and visible NANP numbers, and compares them
to the seed value:

  CONFIRMED        seed number appears on the official page
  DISCREPANCY      official page shows a different prominent number (human must decide)
  NOT_FOUND        no phone number found on the page
  OK_ONLINE_ONLY   brand is online_only and no phone was found (consistent)
  REVIEW_HAS_PHONE brand is online_only but a phone DID appear (re-classify?)
  FETCH_BLOCKED    the page could not be retrieved (bot wall / network) -> inconclusive

With --write, entries that come back CONFIRMED have their `verification` block updated
to status=verified with the source URL and today's date. Everything else is left as-is
for human review. CONFIRMED-by-tool still warrants a human spot-check before launch.

Run where the official domains are reachable (this is intentionally network-dependent):

    python data/verify_numbers.py                # report only
    python data/verify_numbers.py --write        # also flip CONFIRMED -> verified
    python data/verify_numbers.py --worksheet    # emit a CSV for manual sign-off
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent
BRANDS = DATA / "brands.json"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
PHONE_RE = re.compile(r"(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})")
TEL_RE = re.compile(r"tel:([+0-9().\-\s]+)", re.IGNORECASE)


def to_e164(raw: str) -> str | None:
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10 or digits[0] in "01":
        return None
    return "+1" + digits


def candidates_from(html: str) -> set[str]:
    found: set[str] = set()
    for raw in TEL_RE.findall(html):
        if (e := to_e164(raw)):
            found.add(e)
    for a, b, c in PHONE_RE.findall(html):
        if (e := to_e164(a + b + c)):
            found.add(e)
    return found


def fetch(url: str, timeout: int = 25) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            charset = r.headers.get_content_charset() or "utf-8"
            return r.read().decode(charset, errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError):
        return None


def classify(brand: dict) -> tuple[str, set[str], str | None]:
    """Returns (status, candidates, source_url_used)."""
    for url in (brand.get("official_support_url"), brand.get("official_url")):
        if not url:
            continue
        html = fetch(url)
        time.sleep(1.0)  # be polite
        if html is None:
            continue
        cands = candidates_from(html)
        seed = brand.get("phone")
        if seed is None:  # online_only
            return ("REVIEW_HAS_PHONE" if cands else "OK_ONLINE_ONLY", cands, url)
        if seed in cands:
            return ("CONFIRMED", cands, url)
        if cands:
            return ("DISCREPANCY", cands, url)
        return ("NOT_FOUND", cands, url)
    return ("FETCH_BLOCKED", set(), None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="flip CONFIRMED entries to verified")
    ap.add_argument("--worksheet", action="store_true", help="emit a manual-verification CSV and exit")
    args = ap.parse_args()

    doc = json.loads(BRANDS.read_text())
    brands = doc["brands"]

    if args.worksheet:
        w = csv.writer(sys.stdout)
        w.writerow(["id", "name", "seed_phone", "official_support_url",
                    "number_found_on_official_page", "matches_seed (Y/N)", "verified_by", "date"])
        for b in brands:
            w.writerow([b["id"], b["name"], b.get("phone") or "(online_only)",
                        b.get("official_support_url", ""), "", "", "", ""])
        return 0

    today = dt.date.today().isoformat()
    counts: dict[str, int] = {}
    print(f"{'id':18} {'status':16} {'seed':14} candidates")
    print("-" * 78)
    for b in brands:
        status, cands, url = classify(b)
        counts[status] = counts.get(status, 0) + 1
        seed = b.get("phone") or "online_only"
        print(f"{b['id']:18} {status:16} {seed:14} {', '.join(sorted(cands)) or '-'}")
        if args.write and status == "CONFIRMED":
            b["verification"] = {
                "status": "verified",
                "source": url,
                "verified_on": today,
                "verified_by": "verify_numbers.py",
            }

    print("-" * 78)
    print("Summary:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    if args.write:
        BRANDS.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print(f"\nWrote verified status for {counts.get('CONFIRMED', 0)} CONFIRMED brand(s).")
        print("NOTE: tool-confirmed still warrants a human spot-check before launch.")

    # FETCH_BLOCKED means inconclusive, not a pass; surface it as a soft failure signal.
    return 1 if counts.get("FETCH_BLOCKED") else 0


if __name__ == "__main__":
    sys.exit(main())
