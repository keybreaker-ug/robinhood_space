from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
EXPECTED_SOURCE_CSS_SHA256 = "2b5f594468c11ce03cc681be3913a922de932796ece6acc8d2a70b484571505f"
SECTION_ORDER = [
    "overview", "benchmarks", "heatmap", "xirr", "allocation", "valuation",
    "categories", "funds", "holdings", "risk", "board", "range", "activity",
    "gains", "composition",
]


def test_source_css_is_byte_exact_before_login_additions():
    html = INDEX.read_text(encoding="utf-8")
    css = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
    source_css = css.split("\n[hidden]", 1)[0].rstrip()
    assert hashlib.sha256(source_css.encode()).hexdigest() == EXPECTED_SOURCE_CSS_SHA256


def test_all_dashboard_sections_remain_in_order():
    soup = BeautifulSoup(INDEX.read_text(encoding="utf-8"), "html.parser")
    sections = [node.get("id") for node in soup.select("main section")]
    assert sections == SECTION_ORDER


def test_required_interactions_and_accessibility_are_present():
    html = INDEX.read_text(encoding="utf-8")
    for token in (
        'role="dialog"', 'aria-modal="true"', "IntersectionObserver", "calcXirr",
        "drawHeat", "renderTable", "openDrawer", "focus()", "aria-sort",
        "localStorage", "Escape", "refreshDashboard", "logoutDashboard",
    ):
        assert token in html


def test_no_private_portfolio_payload_or_legacy_market_language():
    html = INDEX.read_text(encoding="utf-8")
    visible_text = BeautifulSoup(html, "html.parser").get_text(" ")
    for token in (
        "Sharekhan", "NSDL portfolio", "₹", "BSE Sensex", "Nifty 50",
        "FY2024-25", "No FY25 trades",
    ):
        assert token not in html
        assert token not in visible_text
    assert not re.search(r"\bconst\s+DATA\s*=\s*\{", html)


def test_frontend_javascript_parses(tmp_path):
    node = shutil.which("node")
    if not node:
        return
    soup = BeautifulSoup(INDEX.read_text(encoding="utf-8"), "html.parser")
    scripts = "\n".join(script.string or "" for script in soup.find_all("script"))
    script_path = tmp_path / "dashboard.js"
    script_path.write_text(scripts, encoding="utf-8")
    result = subprocess.run([node, "--check", str(script_path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
