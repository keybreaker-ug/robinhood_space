"""Local-only Robinhood portfolio dashboard backend.

Robinhood is the authoritative source. Yahoo Finance is queried only for fields
that Robinhood does not return. The browser never receives credentials, access
tokens, account numbers, or cached authentication material.
"""

from __future__ import annotations

import inspect
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

import robin_stocks.robinhood as rh
import yfinance as yf
from flask import Flask, jsonify, request, send_from_directory
from pyxirr import xirr


APP_ROOT = Path(__file__).resolve().parent
ET = ZoneInfo("America/New_York")
CACHE_TTL_SECONDS = 60

app = Flask(__name__, static_folder=str(APP_ROOT), static_url_path="/static")
app.config.update(JSON_SORT_KEYS=False, MAX_CONTENT_LENGTH=32 * 1024)

_state_lock = Lock()
_logged_in = False
_portfolio_cache: dict[str, Any] = {"created": 0.0, "data": None}
_instrument_cache: dict[str, dict[str, Any]] = {}


def _number(value: Any, default: float | None = None) -> float | None:
    """Return a finite JSON-safe float or the supplied default."""

    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _truthy_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _date(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        normalized = text.replace(" ET", "")
        for pattern in (
            "%Y-%m-%d",
            "%m/%d/%Y",
            "%d/%m/%Y",
            "%d %b %Y",
            "%d %b %Y %H:%M",
        ):
            try:
                parsed = datetime.strptime(normalized, pattern)
                break
            except ValueError:
                continue
        else:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(ET)


def _display_date(value: Any) -> str:
    parsed = _date(value)
    return parsed.strftime("%d %b %Y") if parsed else ""


def _days_held(value: Any, now: datetime | None = None) -> int:
    parsed = _date(value)
    if not parsed:
        return 0
    return max(0, ((now or datetime.now(ET)) - parsed).days)


def _market_cap_bucket(value: float | None) -> str:
    if not value or value <= 0:
        return "Unclassified"
    if value >= 200_000_000_000:
        return "Mega cap"
    if value >= 10_000_000_000:
        return "Large cap"
    if value >= 2_000_000_000:
        return "Mid cap"
    if value >= 300_000_000:
        return "Small cap"
    return "Micro cap"


def _is_etf(raw_holding: dict[str, Any], instrument: dict[str, Any]) -> bool:
    kind = " ".join(
        str(value or "").lower()
        for value in (
            raw_holding.get("type"),
            instrument.get("type"),
            instrument.get("tradeable_chain_id"),
        )
    )
    name = str(raw_holding.get("name") or instrument.get("name") or "").lower()
    return any(token in kind for token in ("etp", "etf", "fund")) or any(
        token in name
        for token in (" etf", "index fund", "ishares", "vanguard", "spdr", "invesco")
    )


def _instrument(url: str | None) -> dict[str, Any]:
    if not url:
        return {}
    if url in _instrument_cache:
        return _instrument_cache[url]
    try:
        data = rh.stocks.get_instrument_by_url(url) or {}
    except Exception:
        data = {}
    if isinstance(data, dict):
        _instrument_cache[url] = data
        return data
    return {}


def _symbol_for_order(order: dict[str, Any]) -> str:
    symbol = str(order.get("symbol") or "").strip().upper()
    if symbol:
        return symbol
    return str(_instrument(order.get("instrument")).get("symbol") or "").strip().upper()


def _batch_by_symbol(callable_: Any, symbols: list[str]) -> dict[str, dict[str, Any]]:
    if not symbols:
        return {}
    try:
        rows = callable_(symbols) or []
    except Exception:
        return {}
    if isinstance(rows, dict):
        rows = [rows]
    result: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").strip().upper()
        if not symbol and index < len(symbols):
            symbol = symbols[index]
        if symbol:
            result[symbol] = row
    return result


def _yahoo_fallback(symbol: str) -> dict[str, Any]:
    """Fetch only missing public market fields; never fetch account data."""

    try:
        ticker = yf.Ticker(symbol)
        info = ticker.info or {}
        fast = ticker.fast_info
    except Exception:
        return {}

    def fast_value(key: str) -> Any:
        try:
            return fast.get(key) if hasattr(fast, "get") else fast[key]
        except Exception:
            return None

    quote_type = str(info.get("quoteType") or "").upper()
    return {
        "current": _number(fast_value("last_price") or info.get("currentPrice")),
        "previous_close": _number(
            fast_value("previous_close") or info.get("previousClose")
        ),
        "sector": info.get("sector") or info.get("category"),
        "industry": info.get("industry"),
        "pe": _number(info.get("trailingPE")),
        "market_cap": _number(fast_value("market_cap") or info.get("marketCap")),
        "high_52": _number(fast_value("year_high") or info.get("fiftyTwoWeekHigh")),
        "low_52": _number(fast_value("year_low") or info.get("fiftyTwoWeekLow")),
        "is_etf": quote_type == "ETF",
    }


def _fetch_executions() -> list[dict[str, Any]]:
    """Return normalized, filled stock executions in chronological order."""

    try:
        orders = rh.orders.get_all_stock_orders() or []
    except Exception:
        return []

    rows: list[dict[str, Any]] = []
    for order in orders:
        if not isinstance(order, dict) or order.get("state") != "filled":
            continue
        symbol = _symbol_for_order(order)
        if not symbol:
            continue
        side = str(order.get("side") or "").lower()
        for execution in order.get("executions") or []:
            quantity = _number(execution.get("quantity"), 0.0) or 0.0
            price = _number(execution.get("price"), 0.0) or 0.0
            notional = _number(execution.get("rounded_notional"))
            if notional is None:
                notional = quantity * price
            timestamp = execution.get("timestamp") or order.get("last_transaction_at")
            if quantity <= 0 or price < 0 or not _date(timestamp):
                continue
            rows.append(
                {
                    "symbol": symbol,
                    "name": symbol,
                    "side": side,
                    "quantity": quantity,
                    "price": price,
                    "value": abs(notional),
                    "timestamp": timestamp,
                }
            )
    rows.sort(key=lambda row: _date(row["timestamp"]) or datetime.min.replace(tzinfo=ET))
    return rows


def _fifo_open_lots(
    symbol: str,
    executions: list[dict[str, Any]],
    current_quantity: float,
    authoritative_cost: float,
    current_price: float,
) -> list[dict[str, Any]]:
    """Estimate remaining buy lots and reconcile them to Robinhood's cost basis."""

    queue: list[dict[str, Any]] = []
    for execution in (row for row in executions if row["symbol"] == symbol):
        quantity = execution["quantity"]
        if execution["side"] == "buy":
            queue.append(
                {
                    "quantity": quantity,
                    "price": execution["price"],
                    "timestamp": execution["timestamp"],
                }
            )
            continue
        if execution["side"] != "sell":
            continue
        remaining = quantity
        while remaining > 1e-10 and queue:
            used = min(remaining, queue[0]["quantity"])
            queue[0]["quantity"] -= used
            remaining -= used
            if queue[0]["quantity"] <= 1e-10:
                queue.pop(0)

    queue = [lot for lot in queue if lot["quantity"] > 1e-10]
    estimated_quantity = sum(lot["quantity"] for lot in queue)
    if estimated_quantity <= 0 or current_quantity <= 0:
        return []

    quantity_scale = current_quantity / estimated_quantity
    weights = [max(lot["quantity"] * lot["price"], lot["quantity"]) for lot in queue]
    total_weight = sum(weights) or 1.0
    now = datetime.now(ET)
    lots: list[dict[str, Any]] = []
    for lot, weight in zip(queue, weights):
        quantity = lot["quantity"] * quantity_scale
        allocated_cost = authoritative_cost * weight / total_weight
        rate = allocated_cost / quantity if quantity else 0.0
        days = _days_held(lot["timestamp"], now)
        lots.append(
            {
                "term": "LT" if days >= 365 else "ST",
                "qty": quantity,
                "date": _display_date(lot["timestamp"]),
                "rate": rate,
                "days": days,
                "gl": quantity * (current_price - rate),
                "cmp": current_price,
                "corp": "T",
            }
        )
    return lots


def _corporate_events(symbol: str) -> list[dict[str, Any]]:
    try:
        splits = rh.stocks.get_splits(symbol) or []
    except Exception:
        splits = []
    try:
        corporate_events = rh.stocks.get_events(symbol) or []
    except Exception:
        corporate_events = []
    events: list[dict[str, Any]] = []
    for split in splits[-8:]:
        if not isinstance(split, dict):
            continue
        date_value = split.get("execution_date")
        label = "SPLIT"
        multiplier = split.get("multiplier")
        divisor = split.get("divisor")
        if multiplier and divisor:
            label = f"SPLIT {multiplier}:{divisor}"
        events.append(
            {
                "term": "",
                "qty": 0.0,
                "date": _display_date(date_value),
                "rate": 0.0,
                "days": _days_held(date_value),
                "gl": 0.0,
                "cmp": 0.0,
                "corp": label,
            }
        )
    for event in corporate_events[-8:]:
        if not isinstance(event, dict):
            continue
        date_value = event.get("event_date") or event.get("effective_date")
        label = str(event.get("type") or event.get("event_type") or "EVENT").upper()
        events.append(
            {
                "term": "",
                "qty": 0.0,
                "date": _display_date(date_value),
                "rate": 0.0,
                "days": _days_held(date_value),
                "gl": 0.0,
                "cmp": 0.0,
                "corp": label,
            }
        )
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for event in events:
        unique[(event["date"], event["corp"])] = event
    return list(unique.values())


def _holding_xirr(lots: list[dict[str, Any]], current_value: float) -> float | None:
    cash_lots = [lot for lot in lots if lot.get("rate", 0) > 0 and lot.get("qty", 0) > 0]
    if not cash_lots or current_value <= 0:
        return None
    dates = [_date(lot["date"]) for lot in cash_lots]
    if any(value is None for value in dates):
        return None
    amounts = [-(lot["qty"] * lot["rate"]) for lot in cash_lots]
    dates.append(datetime.now(ET))
    amounts.append(current_value)
    try:
        value = float(xirr(dates, amounts))
    except Exception:
        return None
    return value if math.isfinite(value) else None


def _dividend_total() -> float:
    try:
        rows = rh.account.get_dividends() or []
    except Exception:
        return 0.0
    total = 0.0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("state") or "").lower() not in {"paid", "reinvested", ""}:
            continue
        total += _number(row.get("amount"), 0.0) or 0.0
    return total


def _market_state() -> str:
    try:
        hours = rh.markets.get_market_today_hours("XNYS") or {}
        if isinstance(hours, dict) and isinstance(hours.get("is_open"), bool):
            return "open" if hours["is_open"] else "closed"
    except Exception:
        pass
    now = datetime.now(ET)
    minute = now.hour * 60 + now.minute
    return "open" if now.weekday() < 5 and 570 <= minute < 960 else "closed"


def _benchmark_rows() -> list[dict[str, Any]]:
    symbols = ["SPY", "QQQ"]
    quotes = _batch_by_symbol(rh.stocks.get_quotes, symbols)
    rows: list[dict[str, Any]] = []
    for symbol in symbols:
        quote = quotes.get(symbol, {})
        current = _number(
            quote.get("last_extended_hours_trade_price")
            or quote.get("last_trade_price")
        )
        previous = _number(quote.get("adjusted_previous_close") or quote.get("previous_close"))
        source = "Robinhood"
        if current is None or previous is None:
            fallback = _yahoo_fallback(symbol)
            current = current if current is not None else fallback.get("current")
            previous = previous if previous is not None else fallback.get("previous_close")
            source = "Robinhood + Yahoo fallback" if quote else "Yahoo fallback"
        change = ((current - previous) / previous * 100) if current is not None and previous else None
        rows.append(
            {
                "name": symbol,
                "level": current,
                "prev_close": previous,
                "chg_pct": change,
                "source": source,
            }
        )
    return rows


def _group_rows(holdings: list[dict[str, Any]], key: str, label_key: str) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for holding in holdings:
        grouped[str(holding.get(key) or "Unclassified")].append(holding)
    total = sum(holding["cur_value"] for holding in holdings) or 1.0
    rows: list[dict[str, Any]] = []
    for label, members in grouped.items():
        value = sum(member["cur_value"] for member in members)
        pe_rows = [member for member in members if member.get("pe")]
        average_pe = (
            sum(member["pe"] * member["cur_value"] for member in pe_rows)
            / sum(member["cur_value"] for member in pe_rows)
            if pe_rows and sum(member["cur_value"] for member in pe_rows)
            else None
        )
        rows.append(
            {
                label_key: label,
                "value": value,
                "count": len(members),
                "weight": value / total * 100,
                "avg_pe": average_pe,
            }
        )
    return sorted(rows, key=lambda row: row["value"], reverse=True)


def _empty_dashboard() -> dict[str, Any]:
    now = datetime.now(ET)
    return {
        "meta": {
            "holder": "Robinhood Portfolio",
            "broker": "Robinhood",
            "generated": now.strftime("%Y-%m-%d"),
            "live": {
                "asof": now.strftime("%d %b %Y %H:%M ET"),
                "source": "Robinhood",
                "market": _market_state(),
                "n_live": 0,
                "n_stale": 0,
            },
        },
        "totals": {
            "total_value": 0.0,
            "equity_val": 0.0,
            "mf_val": 0.0,
            "n_holdings": 0,
            "n_equity": 0,
            "n_mf": 0,
            "day_pnl": 0.0,
            "day_pnl_pct": None,
            "port_pe": None,
            "top10_weight": 0.0,
            "top20_weight": 0.0,
        },
        "cg": {
            "realized": {"lt": [None] * 4, "st": [None] * 3, "spec": [None] * 3},
            "open": {"LT": 0.0, "ST": 0.0, "GRAND": 0.0},
            "top_lots": [],
        },
        "holdings": [],
        "indices": _benchmark_rows(),
        "sectors": [],
        "mcaps": [],
        "lots": {},
        "trades": [],
    }


def build_dashboard_data() -> dict[str, Any]:
    """Normalize Robinhood holdings into the exact reference dashboard contract."""

    try:
        raw_holdings = rh.account.build_holdings(with_dividends=False) or {}
    except TypeError:
        raw_holdings = rh.account.build_holdings() or {}
    if not isinstance(raw_holdings, dict) or not raw_holdings:
        return _empty_dashboard()

    symbols = sorted(str(symbol).upper() for symbol in raw_holdings)
    quotes = _batch_by_symbol(rh.stocks.get_quotes, symbols)
    fundamentals = _batch_by_symbol(rh.stocks.get_fundamentals, symbols)
    instruments = _batch_by_symbol(rh.stocks.get_instruments_by_symbols, symbols)
    executions = _fetch_executions()
    execution_names = {
        symbol: str(raw_holdings.get(symbol, {}).get("name") or symbol) for symbol in symbols
    }
    for row in executions:
        row["name"] = execution_names.get(row["symbol"], row["symbol"])

    holdings: list[dict[str, Any]] = []
    fallback_count = 0
    for symbol in symbols:
        raw = raw_holdings.get(symbol) or {}
        quote = quotes.get(symbol, {})
        fundamental = fundamentals.get(symbol, {})
        instrument = instruments.get(symbol, {})
        current = _number(
            quote.get("last_extended_hours_trade_price")
            or quote.get("last_trade_price")
            or raw.get("price")
        )
        previous = _number(quote.get("adjusted_previous_close") or quote.get("previous_close"))
        pe = _number(fundamental.get("pe_ratio") or raw.get("pe_ratio"))
        market_cap = _number(fundamental.get("market_cap"))
        high_52 = _number(fundamental.get("high_52_weeks"))
        low_52 = _number(fundamental.get("low_52_weeks"))
        sector = str(fundamental.get("sector") or "").strip()
        industry = str(fundamental.get("industry") or "").strip()
        missing = any(
            value in (None, "")
            for value in (current, previous, pe, market_cap, high_52, low_52, sector, industry)
        )
        fallback = _yahoo_fallback(symbol) if missing else {}
        fallback_fields: set[str] = set()

        def choose(value: Any, key: str) -> Any:
            if value not in (None, ""):
                return value
            candidate = fallback.get(key)
            if candidate not in (None, ""):
                fallback_fields.add(key)
                return candidate
            return value

        current = choose(current, "current")
        previous = choose(previous, "previous_close")
        pe = choose(pe, "pe")
        market_cap = choose(market_cap, "market_cap")
        high_52 = choose(high_52, "high_52")
        low_52 = choose(low_52, "low_52")
        sector = choose(sector, "sector") or "Unclassified"
        industry = choose(industry, "industry") or ""
        used_fallback = bool(fallback_fields)
        price_fallback = bool(fallback_fields & {"current", "previous_close"})
        if used_fallback:
            fallback_count += 1

        quantity = _number(raw.get("quantity"), 0.0) or 0.0
        average_cost = _number(raw.get("average_buy_price"), 0.0) or 0.0
        current = _number(current, 0.0) or 0.0
        current_value = quantity * current
        cost_value = quantity * average_cost
        gain = current_value - cost_value
        gain_pct = gain / cost_value * 100 if cost_value else None
        day_change_pct = ((current - previous) / previous * 100) if previous else None
        is_etf = _is_etf(raw, instrument) or bool(fallback.get("is_etf"))
        off_high_pct = ((current - high_52) / high_52 * 100) if high_52 else None
        source = "Robinhood + Yahoo fallback" if used_fallback else "Robinhood"
        note_parts = [f"Market data: {source}."]
        if fallback_fields:
            note_parts.append(
                "Yahoo fallback fields: " + ", ".join(sorted(fallback_fields)) + "."
            )
        if not high_52 or not low_52:
            note_parts.append("52-week range unavailable.")
        note_parts.append("Open lots are analytical FIFO estimates reconciled to Robinhood cost basis.")
        holdings.append(
            {
                "isin": symbol,
                "symbol": symbol,
                "name": str(raw.get("name") or instrument.get("name") or symbol),
                "asset": "ETF" if is_etf else "Equity",
                "qty": quantity,
                "avg_cost": average_cost,
                "cmp": current,
                "cur_value": current_value,
                "cost_value": cost_value,
                "gain": gain,
                "gain_pct": gain_pct,
                "day_chg_pct": day_change_pct,
                "pe": pe,
                "sector": sector,
                "industry": industry,
                "mcap": market_cap,
                "mcap_bucket": _market_cap_bucket(market_cap),
                "wk52_high": high_52,
                "wk52_low": low_52,
                "off_high_pct": off_high_pct,
                "live": not price_fallback and bool(quote or raw.get("price")),
                "source": source,
                "fallback_fields": sorted(fallback_fields),
                "note": " ".join(note_parts),
                "htype": "",
                "mf_xirr": None,
                "mf_invested": cost_value,
                "mf_days": 0,
            }
        )

    total_value = sum(holding["cur_value"] for holding in holdings)
    for holding in holdings:
        holding["weight"] = holding["cur_value"] / total_value * 100 if total_value else 0.0

    lots: dict[str, list[dict[str, Any]]] = {}
    top_lots: list[list[Any]] = []
    open_lt = 0.0
    open_st = 0.0
    for holding in holdings:
        symbol = holding["symbol"]
        cash_lots = _fifo_open_lots(
            symbol,
            executions,
            holding["qty"],
            holding["cost_value"],
            holding["cmp"],
        )
        events = _corporate_events(symbol)
        lots[symbol] = cash_lots + events
        terms = {lot["term"] for lot in cash_lots}
        holding["htype"] = "Mixed" if len(terms) > 1 else (next(iter(terms)) if terms else "")
        holding["mf_days"] = max((lot["days"] for lot in cash_lots), default=0)
        hx = _holding_xirr(cash_lots, holding["cur_value"])
        holding["mf_xirr"] = hx * 100 if hx is not None else None
        for lot in cash_lots:
            if lot["term"] == "LT":
                open_lt += max(0.0, lot["gl"])
            else:
                open_st += max(0.0, lot["gl"])
            if lot["gl"] > 0:
                top_lots.append(
                    [
                        symbol,
                        lot["term"],
                        lot["qty"],
                        lot["date"],
                        lot["gl"],
                        "Estimated FIFO",
                    ]
                )

    top_lots.sort(key=lambda row: row[4], reverse=True)
    dividend_total = _dividend_total()
    trades = [
        {
            "exch": "US",
            "scrip": execution["name"],
            "isin": execution["symbol"],
            "symbol": execution["symbol"],
            "date": _display_date(execution["timestamp"]),
            "bs": "B" if execution["side"] == "buy" else "S",
            "qty": execution["quantity"],
            "rate": execution["price"],
            "value": execution["value"],
        }
        for execution in executions
    ]

    holdings.sort(key=lambda holding: holding["cur_value"], reverse=True)
    stock_rows = [holding for holding in holdings if holding["asset"] == "Equity"]
    etf_rows = [holding for holding in holdings if holding["asset"] == "ETF"]
    equity_value = sum(holding["cur_value"] for holding in stock_rows)
    etf_value = sum(holding["cur_value"] for holding in etf_rows)
    day_pnl = sum(
        holding["cur_value"]
        - holding["cur_value"] / (1 + holding["day_chg_pct"] / 100)
        if holding["day_chg_pct"] is not None and holding["day_chg_pct"] > -100
        else 0.0
        for holding in holdings
    )
    previous_value = total_value - day_pnl
    pe_rows = [holding for holding in stock_rows if holding.get("pe") and holding["pe"] > 0]
    pe_denominator = sum(holding["cur_value"] for holding in pe_rows)
    portfolio_pe = (
        sum(holding["pe"] * holding["cur_value"] for holding in pe_rows) / pe_denominator
        if pe_denominator
        else None
    )
    top10 = sum(holding["weight"] for holding in holdings[:10])
    top20 = sum(holding["weight"] for holding in holdings[:20])
    now = datetime.now(ET)
    n_live = sum(1 for holding in holdings if holding["live"])

    return {
        "meta": {
            "holder": "Robinhood Portfolio",
            "broker": "Robinhood",
            "generated": now.strftime("%Y-%m-%d"),
            "live": {
                "asof": now.strftime("%d %b %Y %H:%M ET"),
                "source": (
                    "Robinhood"
                    if fallback_count == 0
                    else f"Robinhood + Yahoo fallback ({fallback_count} holdings)"
                ),
                "market": _market_state(),
                "n_live": n_live,
                "n_stale": len(holdings) - n_live,
            },
        },
        "totals": {
            "total_value": total_value,
            "equity_val": equity_value,
            "mf_val": etf_value,
            "n_holdings": len(holdings),
            "n_equity": len(stock_rows),
            "n_mf": len(etf_rows),
            "day_pnl": day_pnl,
            "day_pnl_pct": day_pnl / previous_value * 100 if previous_value else None,
            "port_pe": portfolio_pe,
            "top10_weight": top10,
            "top20_weight": top20,
        },
        "cg": {
            "realized": {
                "lt": [None, None, None, None],
                "st": [None, None, None],
                "spec": [None, None, dividend_total],
            },
            "open": {"LT": open_lt, "ST": open_st, "GRAND": open_lt + open_st},
            "top_lots": top_lots[:20],
        },
        "holdings": holdings,
        "indices": _benchmark_rows(),
        "sectors": _group_rows(holdings, "sector", "sector"),
        "mcaps": _group_rows(stock_rows, "mcap_bucket", "bucket"),
        "lots": lots,
        "trades": trades,
    }


@app.after_request
def _security_headers(response: Any) -> Any:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'"
    )
    return response


@app.route("/")
def serve_index() -> Any:
    return send_from_directory(APP_ROOT, "index.html")


@app.route("/api/login", methods=["POST"])
def login() -> Any:
    global _logged_in
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    mfa_code = str(payload.get("mfa_code") or payload.get("mfaCode") or "").strip()
    if not username or not password:
        return jsonify(success=False, message="Username and password are required."), 400

    kwargs: dict[str, Any] = {
        "username": username,
        "password": password,
        "store_session": _truthy_env("ROBINHOOD_STORE_SESSION", False),
    }
    if mfa_code:
        kwargs["mfa_code"] = mfa_code
    try:
        accepted = set(inspect.signature(rh.login).parameters)
        result = rh.login(**{key: value for key, value in kwargs.items() if key in accepted})
    except Exception:
        return (
            jsonify(
                success=False,
                message="Robinhood login failed. Check your credentials and approval prompt.",
                requires_2fa=not bool(mfa_code),
            ),
            401,
        )

    if isinstance(result, dict) and result.get("access_token"):
        with _state_lock:
            _logged_in = True
            _portfolio_cache.update(created=0.0, data=None)
        return jsonify(success=True, message="Login successful.", requires_2fa=False)

    requires_2fa = bool(
        isinstance(result, dict) and (result.get("mfa_required") or result.get("challenge"))
    )
    return (
        jsonify(
            success=False,
            message=(
                "Enter the Robinhood verification code and try again."
                if requires_2fa
                else "Robinhood did not authorize this session."
            ),
            requires_2fa=requires_2fa,
        ),
        401,
    )


@app.route("/api/portfolio", methods=["GET"])
def portfolio() -> Any:
    with _state_lock:
        authenticated = _logged_in
        cached = _portfolio_cache.get("data")
        age = monotonic() - float(_portfolio_cache.get("created") or 0.0)
    if not authenticated:
        return jsonify(success=False, message="Not logged in."), 401

    force_refresh = request.args.get("refresh") == "1"
    if cached is not None and age < CACHE_TTL_SECONDS and not force_refresh:
        return jsonify(success=True, data=cached, cached=True)
    try:
        data = build_dashboard_data()
    except Exception:
        return (
            jsonify(
                success=False,
                message="Robinhood portfolio data could not be loaded. Try refreshing shortly.",
            ),
            502,
        )
    with _state_lock:
        _portfolio_cache.update(created=monotonic(), data=data)
    return jsonify(success=True, data=data, cached=False)


@app.route("/api/logout", methods=["POST"])
def logout() -> Any:
    global _logged_in
    try:
        rh.logout()
    except Exception:
        pass
    with _state_lock:
        _logged_in = False
        _portfolio_cache.update(created=0.0, data=None)
    return jsonify(success=True, message="Logged out successfully.")


if __name__ == "__main__":
    print("Robinhood dashboard: http://127.0.0.1:5005")
    app.run(host="127.0.0.1", port=5005, debug=False, threaded=False)
