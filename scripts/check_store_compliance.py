#!/usr/bin/env python3
"""App Store 3.1.3 / Play billing compliance guard.

The entire monetization model depends on the mobile binaries containing ZERO
purchase/pricing/upgrade language: checkout happens only on the web (Apple guideline
3.1.3(a)/(b), "reader"/multiplatform pattern). A single stray "Subscribe now!" string
in the app is a rejection — or worse, a forced switch to IAP with a 15-30% fee.

This scanner checks the *user-facing surface* of both app targets — string literals in
Swift/Kotlin (comments stripped) and text in Android resource XML — for purchase
vocabulary. Internal identifiers (enum cases like `case premium`) don't ship as UI text
and are not flagged. Runs in CI on every push; exits non-zero on any finding.

Usage:  python scripts/check_store_compliance.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# Where user-facing app code lives. Tests and the web funnel are intentionally out of
# scope (the web is ALLOWED to talk about pricing — that's the whole model).
SCAN_ROOTS = [
    (REPO / "ios" / "SeniorDirectory", ("*.swift",)),
    (REPO / "android" / "app" / "src" / "main", ("*.kt", "*.xml")),
]

# Purchase vocabulary that must never appear in a shipped string. Word-bounded,
# case-insensitive. Deliberately includes "premium": as UI copy it advertises a paid
# tier (internal enum identifiers are fine — they aren't string literals).
FORBIDDEN = [
    r"subscri(?:be|ption|ptions)",
    r"upgrade",
    r"purchase",
    r"pricing",
    r"\bprice\b",
    r"billing",
    r"checkout",
    r"buy now",
    r"free trial",
    r"payment",
    r"per month",
    r"per year",
    r"/mo\b",
    r"/yr\b",
    r"\bpremium\b",
    r"\$\d",          # $4.99 etc. ($0/$1 Swift shorthand args never precede a digit in literals we extract)
    r"in-app purchase",
]
FORBIDDEN_RE = re.compile("|".join(f"(?:{p})" for p in FORBIDDEN), re.IGNORECASE)

LINE_COMMENT = re.compile(r"//.*$")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
STRING_LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')
XML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
XML_TAG = re.compile(r"<[^>]+>")


def literals_from_code(text: str) -> list[tuple[int, str]]:
    """(line_no, literal) pairs from Swift/Kotlin source, comments stripped."""
    text = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    out: list[tuple[int, str]] = []
    for i, line in enumerate(text.splitlines(), 1):
        for lit in STRING_LITERAL.findall(LINE_COMMENT.sub("", line)):
            out.append((i, lit))
    return out


def texts_from_xml(text: str) -> list[tuple[int, str]]:
    """(line_no, visible text) from resource XML, comments/tags stripped."""
    text = XML_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    out: list[tuple[int, str]] = []
    for i, line in enumerate(text.splitlines(), 1):
        visible = XML_TAG.sub(" ", line).strip()
        if visible:
            out.append((i, visible))
    return out


def main() -> int:
    findings: list[str] = []
    scanned = 0
    for root, patterns in SCAN_ROOTS:
        for pattern in patterns:
            for path in sorted(root.rglob(pattern)):
                scanned += 1
                text = path.read_text(errors="replace")
                pairs = texts_from_xml(text) if path.suffix == ".xml" else literals_from_code(text)
                for line_no, s in pairs:
                    m = FORBIDDEN_RE.search(s)
                    if m:
                        rel = path.relative_to(REPO)
                        findings.append(f"{rel}:{line_no}: forbidden term '{m.group(0)}' in user-facing string: \"{s[:80]}\"")

    if findings:
        print(f"❌ Store-compliance guard: {len(findings)} purchase-language finding(s) in app targets:\n")
        for f in findings:
            print("  " + f)
        print("\nPricing/purchase copy may exist ONLY on the web (3.1.3). Remove or reword.")
        return 1
    print(f"✅ Store-compliance guard: {scanned} app files scanned, no purchase language in user-facing strings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
