"""Serve the dashboard with the synthetic fixture for visual QA only."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend


FIXTURE = Path(__file__).parent / "fixtures" / "sample_portfolio.json"
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))

backend._logged_in = True
backend.build_dashboard_data = lambda: DATA


if __name__ == "__main__":
    backend.app.run(host="127.0.0.1", port=5005, debug=False, threaded=False)
