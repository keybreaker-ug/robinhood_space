#!/usr/bin/env python3
"""Synchronize canonical assets from this repository's working application."""

from __future__ import annotations

import shutil
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
REPOSITORY = SKILL_DIR.parents[2]
ASSET_DIR = SKILL_DIR / "assets"
SOURCES = {
    "index.html": REPOSITORY / "index.html",
    "backend.py": REPOSITORY / "backend.py",
    "requirements.txt": REPOSITORY / "requirements.txt",
    "sample_portfolio.json": REPOSITORY / "tests/fixtures/sample_portfolio.json",
}


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    for name, source in SOURCES.items():
        if not source.exists():
            raise SystemExit(f"Source is missing: {source}")
        shutil.copy2(source, ASSET_DIR / name)
    print(f"Updated {len(SOURCES)} canonical assets")


if __name__ == "__main__":
    main()
