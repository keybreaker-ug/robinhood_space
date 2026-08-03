from __future__ import annotations

from types import SimpleNamespace

import pytest

import backend


@pytest.fixture(autouse=True)
def reset_state():
    backend._logged_in = False
    backend._portfolio_cache.update(created=0.0, data=None)
    backend._instrument_cache.clear()
    yield
    backend._logged_in = False


@pytest.fixture
def client():
    backend.app.config.update(TESTING=True)
    return backend.app.test_client()


def test_login_requires_credentials(client):
    response = client.post("/api/login", json={})
    assert response.status_code == 400
    assert response.get_json()["success"] is False


def test_login_success_and_logout(client, monkeypatch):
    monkeypatch.setattr(backend.rh, "login", lambda **kwargs: {"access_token": "test"})
    monkeypatch.setattr(backend.rh, "logout", lambda: None)
    response = client.post(
        "/api/login",
        json={"username": "friend@example.com", "password": "not-stored"},
    )
    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert backend._logged_in is True

    response = client.post("/api/logout", json={})
    assert response.status_code == 200
    assert backend._logged_in is False


def test_login_reports_verification_requirement(client, monkeypatch):
    monkeypatch.setattr(
        backend.rh,
        "login",
        lambda **kwargs: {"mfa_required": True, "challenge": {"id": "example"}},
    )
    response = client.post(
        "/api/login",
        json={"username": "friend@example.com", "password": "not-stored"},
    )
    assert response.status_code == 401
    assert response.get_json()["requires_2fa"] is True


def test_portfolio_requires_login(client):
    response = client.get("/api/portfolio")
    assert response.status_code == 401
    assert response.get_json()["success"] is False


def test_portfolio_cache_and_force_refresh(client, monkeypatch):
    backend._logged_in = True
    calls = []

    def fake_build():
        calls.append(True)
        return {"meta": {}, "totals": {}, "holdings": []}

    monkeypatch.setattr(backend, "build_dashboard_data", fake_build)
    assert client.get("/api/portfolio").get_json()["cached"] is False
    assert client.get("/api/portfolio").get_json()["cached"] is True
    assert client.get("/api/portfolio?refresh=1").get_json()["cached"] is False
    assert len(calls) == 2


def test_portfolio_source_error_is_sanitized(client, monkeypatch):
    backend._logged_in = True

    def fail_without_leaking_details():
        raise RuntimeError("private upstream response")

    monkeypatch.setattr(backend, "build_dashboard_data", fail_without_leaking_details)
    response = client.get("/api/portfolio")
    payload = response.get_json()
    assert response.status_code == 502
    assert payload["success"] is False
    assert "private upstream response" not in payload["message"]


def test_robinhood_values_win_and_yahoo_only_fills_gaps(monkeypatch):
    holdings = {
        "AAPL": {
            "name": "Apple",
            "quantity": "2",
            "average_buy_price": "180",
            "price": "224",
            "type": "stock",
        },
        "QQQ": {
            "name": "Invesco QQQ Trust",
            "quantity": "1.5",
            "average_buy_price": "400",
            "price": None,
            "type": "etp",
        },
    }
    quotes = [
        {
            "symbol": "AAPL",
            "last_trade_price": "225",
            "previous_close": "220",
            "adjusted_previous_close": "220",
        },
        {"symbol": "QQQ", "last_trade_price": None, "previous_close": None},
    ]
    fundamentals = [
        {
            "symbol": "AAPL",
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "pe_ratio": "31",
            "market_cap": "3400000000000",
            "high_52_weeks": "237",
            "low_52_weeks": "164",
        },
        {"symbol": "QQQ", "sector": None, "industry": None},
    ]
    instruments = [
        {"symbol": "AAPL", "type": "stock", "name": "Apple"},
        {"symbol": "QQQ", "type": "etp", "name": "Invesco QQQ Trust"},
    ]
    orders = [
        {
            "state": "filled",
            "symbol": "AAPL",
            "side": "buy",
            "executions": [
                {"quantity": "2", "price": "180", "timestamp": "2025-01-15T15:00:00Z"}
            ],
        },
        {
            "state": "filled",
            "symbol": "QQQ",
            "side": "buy",
            "executions": [
                {"quantity": "1.5", "price": "400", "timestamp": "2026-01-15T15:00:00Z"}
            ],
        },
    ]
    monkeypatch.setattr(backend.rh.account, "build_holdings", lambda **kwargs: holdings)
    monkeypatch.setattr(backend.rh.account, "get_dividends", lambda: [])
    monkeypatch.setattr(backend.rh.orders, "get_all_stock_orders", lambda: orders)
    monkeypatch.setattr(backend.rh.stocks, "get_quotes", lambda symbols: quotes)
    monkeypatch.setattr(backend.rh.stocks, "get_fundamentals", lambda symbols: fundamentals)
    monkeypatch.setattr(
        backend.rh.stocks, "get_instruments_by_symbols", lambda symbols: instruments
    )
    monkeypatch.setattr(backend.rh.stocks, "get_splits", lambda symbol: [])
    monkeypatch.setattr(backend.rh.stocks, "get_events", lambda symbol: [])
    monkeypatch.setattr(backend.rh.markets, "get_market_today_hours", lambda market: {"is_open": False})
    monkeypatch.setattr(backend, "_benchmark_rows", lambda: [])

    fallback_calls = []

    def fallback(symbol):
        fallback_calls.append(symbol)
        return {
            "current": 475.0,
            "previous_close": 470.0,
            "sector": "ETF",
            "industry": "Large Growth",
            "pe": None,
            "market_cap": None,
            "high_52": 503.0,
            "low_52": 342.0,
            "is_etf": True,
        }

    monkeypatch.setattr(backend, "_yahoo_fallback", fallback)
    data = backend.build_dashboard_data()
    rows = {row["symbol"]: row for row in data["holdings"]}

    assert rows["AAPL"]["cmp"] == 225.0
    assert rows["AAPL"]["source"] == "Robinhood"
    assert rows["AAPL"]["sector"] == "Technology"
    assert rows["QQQ"]["cmp"] == 475.0
    assert rows["QQQ"]["source"] == "Robinhood + Yahoo fallback"
    assert rows["QQQ"]["asset"] == "ETF"
    assert "current" in rows["QQQ"]["fallback_fields"]
    assert "Yahoo fallback fields:" in rows["QQQ"]["note"]
    assert fallback_calls == ["QQQ"]
    assert data["totals"]["n_holdings"] == 2
    assert data["meta"]["live"]["n_stale"] == 1


def test_fifo_sells_and_reconciles_to_authoritative_cost():
    executions = [
        {"symbol": "ABC", "side": "buy", "quantity": 10.0, "price": 10.0, "timestamp": "2024-01-01"},
        {"symbol": "ABC", "side": "buy", "quantity": 10.0, "price": 20.0, "timestamp": "2025-01-01"},
        {"symbol": "ABC", "side": "sell", "quantity": 5.0, "price": 30.0, "timestamp": "2025-06-01"},
    ]
    lots = backend._fifo_open_lots("ABC", executions, 15.0, 250.0, 30.0)
    assert pytest.approx(sum(lot["qty"] for lot in lots)) == 15.0
    assert pytest.approx(sum(lot["qty"] * lot["rate"] for lot in lots)) == 250.0


def test_empty_account_returns_complete_schema(monkeypatch):
    monkeypatch.setattr(backend.rh.account, "build_holdings", lambda **kwargs: {})
    monkeypatch.setattr(backend, "_benchmark_rows", lambda: [])
    monkeypatch.setattr(backend, "_market_state", lambda: "closed")
    data = backend.build_dashboard_data()
    assert data["totals"]["n_holdings"] == 0
    assert data["holdings"] == []
    assert {"meta", "totals", "cg", "indices", "sectors", "mcaps", "lots", "trades"}.issubset(data)


def test_security_headers(client):
    response = client.get("/")
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Cache-Control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
