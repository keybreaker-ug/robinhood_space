from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".claude/skills/building-robinhood-dashboard"


def test_skill_has_no_todos():
    assert "TODO" not in (SKILL / "SKILL.md").read_text(encoding="utf-8")


def test_canonical_assets_match_working_app():
    assert (SKILL / "assets/index.html").read_bytes() == (ROOT / "index.html").read_bytes()
    assert (SKILL / "assets/backend.py").read_bytes() == (ROOT / "backend.py").read_bytes()
    assert (SKILL / "assets/requirements.txt").read_bytes() == (ROOT / "requirements.txt").read_bytes()


def test_scaffold_reproduces_and_validates(tmp_path):
    target = tmp_path / "friend-dashboard"
    scaffold = SKILL / "scripts/scaffold.py"
    validate = SKILL / "scripts/validate.py"
    subprocess.run([sys.executable, str(scaffold), str(target)], check=True)
    result = subprocess.run(
        [sys.executable, str(validate), str(target)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
