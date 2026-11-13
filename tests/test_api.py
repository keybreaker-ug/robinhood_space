import json
from pathlib import Path
import pickle
import tempfile
import time
import unittest
from unittest.mock import patch

import backend


class ApiTests(unittest.TestCase):
    def setUp(self):
        # Keep atomic-rename fixtures on the workspace volume. The Windows
        # sandbox's virtualized temporary directory does not support replace.
        directory = backend.ROOT / "instance" / "tests"
        directory.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {"TESTING": True, "SECRET_KEY": "test-session-signing-key", "SESSION_STATE_PATH": self.root / "state.json",
                       "BROKER_TOKEN_DIRECTORY": self.root / "tokens"}
        self.app = backend.create_app(self.config)
        self.client = self.app.test_client()
        self.controller = self.app.extensions["browser_session"]
        self.login_patch = patch("auth.rh.login", side_effect=self.fake_login)
        self.login_mock = self.login_patch.start()
        self.addCleanup(self.login_patch.stop)
        self.profile_patch = patch("auth.rh.profiles.load_account_profile", return_value={"account_number": "test"})
        self.profile_mock = self.profile_patch.start()
        self.addCleanup(self.profile_patch.stop)
        self.data_patch = patch("backend.load_portfolio", return_value={"stocks": [], "totalProfitLoss": 50})
        self.data_mock = self.data_patch.start()
        self.addCleanup(self.data_patch.stop)
        self.detail_patch = patch("backend.holding_detail", return_value={"prices": []})
        self.detail_patch.start()
        self.addCleanup(self.detail_patch.stop)
        self.addCleanup(self.controller.clear_broker)

    def fake_login(self, **kwargs):
        path = Path(kwargs["pickle_path"]) / "robinhood.pickle"
        self.assertFalse(path.exists(), "Explicit login must not skip password validation using an old cache")
        path.write_bytes(pickle.dumps({"access_token": "fixture-token", "token_type": "Bearer", "refresh_token": "fixture-refresh"}))
        return {"access_token": "fixture-token"}

    def sign_in(self, client=None, username="person@example.com"):
        response = (client or self.client).post("/api/login", json={"username": username, "password": "fixture-password"})
        self.assertEqual(response.status_code, 200)
        return response

    def test_authenticated_access_and_another_browser_are_separate(self):
        self.sign_in()
        self.assertEqual(self.client.get("/api/portfolio").status_code, 200)
        other = self.app.test_client()
        self.assertEqual(other.get("/api/portfolio").status_code, 401)
        self.assertFalse(other.get("/api/check-session").json["logged_in"])
        self.profile_mock.assert_not_called()
        self.assertEqual(self.client.get("/api/portfolio").status_code, 200)

    def test_expiry_is_enforced_on_every_protected_endpoint(self):
        self.sign_in()
        state = self.controller.read_state()
        state["started_at"] = time.time() - 2701
        self.controller.state_path.write_text(json.dumps(state))
        for path in ["/api/portfolio", "/api/holding/AAPL", "/api/session-info"]:
            self.assertEqual(self.client.get(path).status_code, 401)
        self.data_mock.assert_not_called()
        self.assertFalse(self.controller.broker_ready)
        self.assertFalse(self.controller.state_path.exists())

    def test_restart_restores_only_for_the_owner_without_extending_expiry(self):
        self.sign_in()
        state = self.controller.read_state()
        path = self.controller.token_path(state)
        mtime = path.stat().st_mtime_ns
        cookie = self.client.get_cookie("ravenhood_session").value
        restarted = backend.create_app(self.config)
        restored = restarted.test_client()
        restored.set_cookie("ravenhood_session", cookie)
        self.assertTrue(restored.get("/api/check-session").json["logged_in"])
        self.profile_mock.assert_called_once()
        self.assertEqual(restarted.extensions["browser_session"].read_state()["started_at"], state["started_at"])
        self.assertEqual(path.stat().st_mtime_ns, mtime)
        self.assertFalse(restarted.test_client().get("/api/check-session").json["logged_in"])

    def test_invalid_saved_token_does_not_prompt_for_credentials(self):
        self.sign_in()
        state = self.controller.read_state()
        self.controller.token_path(state).write_bytes(b"changed cache")
        self.controller.broker_ready = False
        self.assertFalse(self.client.get("/api/check-session").json["logged_in"])
        self.assertEqual(self.login_mock.call_count, 1)
        self.profile_mock.assert_not_called()

    def test_logout_invalidates_replayed_cookie_but_preserves_broker_cache(self):
        self.sign_in()
        cookie = self.client.get_cookie("ravenhood_session").value
        path = self.controller.token_path(self.controller.read_state())
        self.assertEqual(self.client.post("/api/logout").status_code, 200)
        self.assertTrue(path.exists())
        self.client.set_cookie("ravenhood_session", cookie)
        self.assertEqual(self.client.get("/api/portfolio").status_code, 401)

    def test_clear_session_removes_its_namespaced_token(self):
        self.sign_in()
        path = self.controller.token_path(self.controller.read_state())
        self.assertEqual(self.client.post("/api/clear-session").status_code, 200)
        self.assertFalse(path.exists())
        self.assertIsNone(self.client.get_cookie("ravenhood_session"))

    def test_account_switch_uses_another_cache_and_invalidates_old_browser(self):
        self.sign_in()
        old_scope = self.controller.read_state()["scope"]
        second = self.app.test_client()
        self.sign_in(second, "another@example.com")
        self.assertNotEqual(old_scope, self.controller.read_state()["scope"])
        self.assertEqual(self.client.get("/api/portfolio").status_code, 401)
        self.assertEqual(second.get("/api/portfolio").status_code, 200)

    def test_explicit_login_never_reuses_a_saved_token_in_place_of_password_validation(self):
        self.sign_in()
        saved = self.controller.token_path(self.controller.read_state())
        old_bytes = saved.read_bytes()
        def reject(**kwargs):
            self.assertFalse((Path(kwargs["pickle_path"]) / "robinhood.pickle").exists())
            return None
        self.login_mock.side_effect = reject
        other = self.app.test_client()
        self.assertEqual(other.post("/api/login", json={"username": "person@example.com", "password": "wrong"}).status_code, 401)
        self.assertEqual(saved.read_bytes(), old_bytes)
        self.assertEqual(self.client.get("/api/portfolio").status_code, 200)

    def test_cross_origin_and_cross_site_requests_are_rejected(self):
        self.sign_in()
        for method, path in [("get", "/api/portfolio"), ("post", "/api/logout"), ("post", "/api/login")]:
            response = getattr(self.client, method)(path, headers={"Origin": "https://example.invalid"})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        for site in ("same-site", "cross-site"):
            self.assertEqual(self.client.get("/api/portfolio", headers={"Sec-Fetch-Site": site}).status_code, 403)
        self.assertEqual(self.client.get("/api/portfolio", headers={"Origin": "http://localhost"}).status_code, 200)

    def test_untrusted_host_is_rejected(self):
        self.assertEqual(self.client.get("/api/check-session", headers={"Host": "evil.example"}).status_code, 400)

    def test_source_and_git_metadata_are_not_static_files(self):
        for path in ["/./backend.py", "/.%2Fbackend.py", "/./.git/HEAD", "/static/../backend.py", "/instance/secret.key"]:
            self.assertEqual(self.client.get(path).status_code, 404, path)
        with self.client.get("/") as response:
            self.assertEqual(response.status_code, 200)
        with self.client.get("/static/app.js") as response:
            self.assertEqual(response.status_code, 200)

    def test_login_input_validation_and_cookie_flags(self):
        for payload in [[], {}, {"username": {}, "password": "x"}, {"username": "x", "password": []}]:
            self.assertEqual(self.client.post("/api/login", json=payload).status_code, 400)
        response = self.sign_in()
        cookie = response.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn("fixture-token", cookie)
        self.assertNotIn("fixture-password", cookie)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_browser_policy_blocks_remote_scripts_and_connections(self):
        with self.client.get("/") as response:
            policy = response.headers["Content-Security-Policy"]
            self.assertIn("script-src 'self'", policy)
            self.assertIn("connect-src 'self'", policy)
            self.assertNotIn("'unsafe-inline'", policy)
            self.assertEqual(response.headers["Cross-Origin-Resource-Policy"], "same-origin")
            self.assertIn(b'src="/static/portfolio-atlas/app.js"', response.data)
            self.assertNotIn(b'/static/atlas.css', response.data)
        with self.client.get("/static/portfolio-atlas/app.js") as response:
            self.assertEqual(response.status_code, 200)

    def test_invalid_holding_symbols_are_rejected(self):
        self.sign_in()
        self.assertEqual(self.client.get("/api/holding/AAPL?assetType=unknown").status_code, 400)
        self.assertEqual(self.client.get("/api/holding/bad%20symbol").status_code, 400)

    def test_research_requires_local_session_and_only_passes_valid_public_tickers(self):
        body = {"mode": "market", "symbols": [{"symbol": "aapl", "assetType": "stock"}] * 2}
        with patch("backend.research_snapshots", return_value=[{"symbol": "AAPL"}]) as snapshots:
            self.assertEqual(self.client.post("/api/research", json=body).status_code, 401)
            self.sign_in()
            self.assertEqual(self.client.post("/api/research", json=body, headers={"Origin": "https://example.com"}).status_code, 403)
            self.assertEqual(self.client.post("/api/research", json={**body, "mode": "funds"}).status_code, 400)
            self.assertEqual(self.client.post("/api/research", json={**body, "symbols": body["symbols"] * 7}).status_code, 400)
            snapshots.assert_not_called()
            response = self.client.post("/api/research", json=body)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["data"], [{"symbol": "AAPL"}])
            snapshots.assert_called_once_with([("AAPL", "stock")], "market")

    def test_research_preferences_scope_is_stable_and_account_specific(self):
        self.sign_in()
        first = self.client.get("/api/portfolio").json["data"]["researchScope"]
        self.assertEqual(first, self.client.get("/api/portfolio").json["data"]["researchScope"])
        self.assertNotEqual(first, self.controller.read_state()["scope"])
        self.sign_in(username="another@example.com")
        self.assertNotEqual(first, self.client.get("/api/portfolio").json["data"]["researchScope"])

    def test_benchmark_history_requires_auth_and_an_allowlisted_symbol(self):
        with patch("backend.benchmark_history_snapshot", return_value=[{"date": "2026-01-01", "close": 500}]) as history:
            self.assertEqual(self.client.get("/api/benchmarks/VOO").status_code, 401)
            self.sign_in()
            self.assertEqual(self.client.get("/api/benchmarks/OTHER").status_code, 400)
            self.assertEqual(self.client.get("/api/benchmarks/QQQ", headers={"Origin": "https://example.com"}).status_code, 403)
            self.assertEqual(self.client.get("/api/benchmarks/VOO").json["data"], [{"date": "2026-01-01", "close": 500}])
            history.assert_called_once_with("VOO")

    def test_atlas_snapshot_uses_authenticated_robinhood_values_and_voo_cash_flows(self):
        data = {"asOf": "2026-01-02", "stocks": [
            {"assetType": "crypto", "symbol": "BTC", "name": "Bitcoin", "currentValue": 75,
             "currentPrice": 75000, "quantity": 0.001, "costBasis": 50, "xirr": 0.25,
             "avgCost": 50000, "totalReturnPct": 50, "week": 3, "month": -4,
             "timeHeld": "1 year, 1 day", "timeHeldDays": 366},
        ], "totalCurrentValue": 75, "sp500": {"currentValue": 65, "xirr": 0.15},
            "totalInvestment": 50, "cashSummary": {"balance": 20, "interestEarned": 2, "apy": 3.5},
            "dividends": {"reinvested": 4, "paid": 1}, "insights": {"risk": {"beta": 1.2}},
            "historicalData": [{"date": "2026-01-02", "portfolio": 75, "sp500": 65,
                                "assets": {"stock": 0, "etf": 0, "crypto": 75}}]}
        self.assertEqual(self.client.get("/api/atlas/snapshot").status_code, 401)
        self.sign_in()
        with patch("backend.collect_portfolio", return_value=()) as collect, \
             patch("backend.complete_portfolio", return_value=data) as complete:
            result = self.client.get("/api/atlas/snapshot")
            collect.assert_called_once_with()
            complete.assert_called_once_with(include_monthly=False)
            self.assertEqual(self.app.test_client().get("/api/atlas/snapshot").status_code, 401)
            self.assertEqual(self.client.get("/api/atlas/snapshot").json, result.json)
            collect.assert_called_once()
            self.assertEqual(self.client.get("/api/atlas/snapshot?refresh=1").status_code, 200)
            self.assertEqual(collect.call_count, 2)
        self.assertEqual(result.status_code, 200)
        payload = result.json
        self.assertEqual(len(payload["accounts"]), 1)
        holding = payload["accounts"][0]["holdings"][0]
        self.assertEqual((holding["asset"], holding["qty"], holding["cur_value"], holding["brokerXirr"]),
                         ("Crypto", 0.001, 75, 25))
        self.assertEqual(payload["comparison"]["voo"], data["sp500"])
        self.assertEqual(payload["history"]["scopes"]["all"]["points"][0]["crypto"], 75)
        self.assertEqual((holding["avgBuyPrice"], holding["totalReturn"], holding["week"], holding["month"], holding["timeHeldDays"]),
                         (50000, 50, 3, -4, 366))
        account = payload["accounts"][0]
        self.assertEqual(account["summary"], {"netInvested": 50, "balance": 20, "interestEarned": 2,
                                               "apy": 3.5, "dividends": {"reinvested": 4, "paid": 1}})
        self.assertEqual(account["insights"]["risk"]["beta"], 1.2)

    def test_holding_comparison_uses_lifetime_sp500_history(self):
        path = "/api/atlas/benchmarks/sp500"
        points = [["1999-01-22", 1200, 1200, 0], ["2026-01-02", 6800, 6800, 0]]
        with patch("research._atlas_chart", return_value=points) as history:
            self.assertEqual(self.client.get(path).status_code, 401)
            history.assert_not_called()
            self.sign_in()
            self.assertEqual(self.client.get(path).json, {"points": points})
            history.assert_called_once_with("^GSPC", "max")


if __name__ == "__main__":
    unittest.main()
