#!/usr/bin/env python3
"""Keep the app-bundled brand directories identical to the canonical data/brands.json.

    python scripts/sync_brands.py          # copy data/brands.json into both apps
    python scripts/sync_brands.py --check  # exit 1 if either app copy differs (CI gate)

data/brands.json is the only file anyone edits. The iOS and Android copies are
generated from it, so a number fix can never land in one place and not the other.
"""
from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "brands.json"
TARGETS = [
    ROOT / "ios" / "SeniorDirectory" / "Resources" / "brands.json",
    ROOT / "android" / "app" / "src" / "main" / "assets" / "brands.json",
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    check = "--check" in sys.argv[1:]
    want = sha256(SOURCE)
    bad = []
    for target in TARGETS:
        rel = target.relative_to(ROOT)
        have = sha256(target) if target.exists() else None
        if have == want:
            print(f"ok      {rel}")
            continue
        if check:
            bad.append(rel)
            print(f"DRIFT   {rel}  (has {have and have[:12]}, source {want[:12]})")
        else:
            shutil.copyfile(SOURCE, target)
            print(f"synced  {rel}")
    if bad:
        print("App brand data differs from data/brands.json. Run: python scripts/sync_brands.py")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
