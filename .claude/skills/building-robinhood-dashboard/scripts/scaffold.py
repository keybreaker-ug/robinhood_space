#!/usr/bin/env python3
"""Install the canonical dashboard assets into a target directory."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


ASSET_DIR = Path(__file__).resolve().parents[1] / "assets"
FILES = ("index.html", "backend.py", "requirements.txt", "sample_portfolio.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    target = args.target.resolve()
    target.mkdir(parents=True, exist_ok=True)

    conflicts = [name for name in FILES if (target / name).exists()]
    if conflicts and not args.force:
        names = ", ".join(conflicts)
        raise SystemExit(f"Refusing to overwrite: {names}. Re-run with --force only after approval.")
    for name in FILES:
        source = ASSET_DIR / name
        if not source.exists():
            raise SystemExit(f"Canonical asset is missing: {source}")
        shutil.copy2(source, target / name)
    print(f"Scaffolded exact Robinhood dashboard in {target}")


if __name__ == "__main__":
    main()
