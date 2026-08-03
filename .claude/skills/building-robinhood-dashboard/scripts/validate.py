#!/usr/bin/env python3
"""Validate exact UI structure, security invariants, and canonical parity."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


SECTIONS = [
    "overview", "benchmarks", "heatmap", "xirr", "allocation", "valuation",
    "categories", "funds", "holdings", "risk", "board", "range", "activity",
    "gains", "composition",
]
SOURCE_CSS_SHA256 = "2b5f594468c11ce03cc681be3913a922de932796ece6acc8d2a70b484571505f"
REQUIRED_IDS = {
    "loginView", "dashboardView", "nav", "themeBtn", "refreshBtn", "logoutBtn",
    "tvHeatmap", "hmSelection", "xirrTop", "dAsset", "dGain", "sectorBars",
    "mcapBars", "mfTable", "tbl", "tbody", "riskMetrics", "lorenz", "txnBody",
    "corpBody", "cgReal", "lots", "drawer", "backdrop",
}
BANNED_TEXT = (
    "Sharekhan", "NSDL", "BEGIN PRIVATE KEY",
    "host='0.0.0.0'", 'host="0.0.0.0"',
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(target: Path) -> list[str]:
    errors: list[str] = []
    index = target / "index.html"
    backend = target / "backend.py"
    requirements = target / "requirements.txt"
    for path in (index, backend, requirements):
        if not path.exists():
            errors.append(f"missing {path.name}")
    if errors:
        return errors

    html = index.read_text(encoding="utf-8")
    backend_text = backend.read_text(encoding="utf-8")
    css_match = re.search(r"<style>(.*?)</style>", html, re.S)
    if not css_match:
        errors.append("missing canonical stylesheet")
    else:
        source_css = css_match.group(1).split("\n[hidden]", 1)[0].rstrip()
        if hashlib.sha256(source_css.encode()).hexdigest() != SOURCE_CSS_SHA256:
            errors.append("canonical dashboard styling was altered")
    found_sections = re.findall(r'<section[^>]+id="([^"]+)"', html)
    dashboard_sections = [name for name in found_sections if name in SECTIONS]
    if dashboard_sections != SECTIONS:
        errors.append(f"section order differs: {dashboard_sections}")
    found_ids = set(re.findall(r'id="([^"]+)"', html))
    missing_ids = sorted(REQUIRED_IDS - found_ids)
    if missing_ids:
        errors.append(f"missing UI ids: {', '.join(missing_ids)}")
    for token in ("role=\"dialog\"", "aria-modal=\"true\"", "IntersectionObserver", "localStorage", "openDrawer", "calcXirr"):
        if token not in html:
            errors.append(f"missing interaction token: {token}")
    for token in BANNED_TEXT:
        if token.lower() in (html + backend_text).lower():
            errors.append(f"forbidden content: {token}")
    if re.search(r"\bconst\s+DATA\s*=\s*\{", html):
        errors.append("embedded portfolio payload detected")
    if re.search(r"gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}", html + backend_text):
        errors.append("credential-like secret detected")
    for route in ('/api/login', '/api/portfolio', '/api/logout'):
        if route not in backend_text:
            errors.append(f"missing API route: {route}")
    if "127.0.0.1" not in backend_text or "debug=False" not in backend_text:
        errors.append("backend is not local-only with debug disabled")
    if "robin_stocks.robinhood" not in backend_text or "yfinance" not in backend_text:
        errors.append("source adapters are incomplete")

    fixture_candidates = [target / "sample_portfolio.json", target / "tests/fixtures/sample_portfolio.json"]
    fixture = next((path for path in fixture_candidates if path.exists()), None)
    if fixture:
        try:
            data = json.loads(fixture.read_text(encoding="utf-8"))
            required = {"meta", "totals", "cg", "holdings", "indices", "sectors", "mcaps", "lots", "trades"}
            if not required.issubset(data):
                errors.append("synthetic fixture does not satisfy dashboard schema")
            if data.get("meta", {}).get("holder") != "Robinhood Portfolio":
                errors.append("fixture holder must remain synthetic")
            if any(row.get("symbol") not in {"AAPL", "MSFT", "NVDA", "SPY", "QQQ"} for row in data.get("holdings", [])):
                errors.append("fixture contains a non-canonical portfolio symbol")
        except json.JSONDecodeError as exc:
            errors.append(f"invalid synthetic fixture: {exc}")

    skill_assets = Path(__file__).resolve().parents[1] / "assets"
    if target.resolve() != skill_assets.resolve():
        for name in ("index.html", "backend.py", "requirements.txt"):
            asset = skill_assets / name
            project_file = target / name
            if asset.exists() and project_file.exists() and digest(asset) != digest(project_file):
                errors.append(f"canonical asset drift: {name}")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    errors = validate(args.target.resolve())
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        raise SystemExit(1)
    print("Exact Robinhood dashboard validation passed")


if __name__ == "__main__":
    main()
