"""Pure calculations for securities analytics (cash and options are excluded).

Purchases, including reinvestments, are contributions to the securities basket.
Sale proceeds and dividends paid out in cash are distributions.
"""
from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta
import math
import logging
import sys

import pandas as pd
from pyxirr import DayCount, xirr

logger = logging.getLogger(__name__)
BENCHMARK_SYMBOL = "VOO"


def number(value, default=None):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError, OverflowError):
        return default


def asset_key(symbol, asset_type="stock"):
    return ("crypto" if asset_type == "crypto" else "stock", symbol.upper())


def event_key(event):
    return asset_key(event["symbol"], event.get("assetType"))


def return_cash_flows(events):
    """Keep reinvestment purchases and omit the income that funded them."""
    return [event for event in events if event["kind"] != "dividend" or not event.get("reinvested")]


def discounted_balance(flows, log_rate):
    """Return XNPV scaled by the largest discounted flow to avoid overflow."""
    magnitudes = [log_amount - years * log_rate for years, log_amount, _ in flows]
    largest = max(magnitudes)
    return math.fsum(sign * math.exp(magnitude - largest)
                     for magnitude, (_, _, sign) in zip(magnitudes, flows))


def money_weighted_return(events, terminal_value, terminal_date):
    if terminal_value is None:
        return None
    totals = defaultdict(float)
    for event in events:
        totals[event["date"]] += event["amount"]
    totals[str(terminal_date)] += terminal_value
    if any(not math.isfinite(amount) for amount in totals.values()):
        return None
    ordered = [(d, v) for d, v in sorted(totals.items()) if abs(v) > 1e-8]
    if len(ordered) < 2:
        return None
    dates, amounts = zip(*ordered)
    signs = [1 if amount > 0 else -1 for amount in amounts]
    sign_changes = sum(a != b for a, b in zip(signs, signs[1:]))
    if not sign_changes:
        return None
    try:
        first = date.fromisoformat(dates[0])
        flows = [((date.fromisoformat(day) - first).days / 365, math.log(abs(amount)), sign)
                 for day, amount, sign in zip(dates, amounts, signs)]
    except ValueError:
        return None
    try:
        rate = number(xirr(dates, amounts, day_count=DayCount.ACT_365F))
    except (ValueError, ArithmeticError):
        rate = None
    if rate is not None and rate > -1 and abs(discounted_balance(flows, math.log1p(rate))) <= 1e-8:
        return rate
    if sign_changes != 1:
        return None

    # With one sign change there is a unique root. Bisect on log(1 + rate)
    # when the default solver misses short-period or extreme returns.
    low = math.log1p(math.nextafter(-1.0, 0.0))
    high = math.log(sys.float_info.max)
    low_balance = discounted_balance(flows, low)
    high_balance = discounted_balance(flows, high)
    if low_balance * high_balance > 0:
        return None
    for _ in range(60):
        middle = (low + high) / 2
        balance = discounted_balance(flows, middle)
        if balance == 0:
            return math.expm1(middle)
        if balance * low_balance > 0:
            low = middle
        else:
            high = middle
    return math.expm1((low + high) / 2)


def daily_history(frame):
    """Normalize timezone-aware market data to sorted exchange calendar dates."""
    if frame is None or frame.empty or "Close" not in frame:
        return pd.DataFrame(columns=["Close", "Stock Splits"])
    result = frame.copy()
    if isinstance(result.index, pd.DatetimeIndex):
        # Keep the exchange's local calendar date while avoiding timezone-aware
        # formatting for every market candle.
        result.index = result.index.tz_localize(None).strftime("%Y-%m-%d")
    else:
        result.index = pd.Index([pd.Timestamp(value).strftime("%Y-%m-%d") for value in result.index])
    result = result[~result.index.duplicated(keep="last")].sort_index()
    result["Close"] = pd.to_numeric(result["Close"], errors="coerce")
    result = result[result["Close"].gt(0)]
    if "Stock Splits" not in result:
        result["Stock Splits"] = 0.0
    else:
        result["Stock Splits"] = pd.to_numeric(result["Stock Splits"], errors="coerce").astype(float)
    return result


def split_factor(history, trade_date):
    """Yahoo Close is split-adjusted; express old trades in today's share units."""
    if history.empty:
        return 1.0
    first = history.index.searchsorted(trade_date, side="right")
    splits = history["Stock Splits"].to_numpy(copy=False)[first:]
    return math.prod(float(value) for value in splits[splits > 0] if math.isfinite(value))


def reconcile_positions(holdings, events, histories):
    """Reject history with missing executions, transfers, or unhandled actions."""
    expected = {asset_key(h["symbol"], h["assetType"]): h["quantity"] for h in holdings}
    quantities = defaultdict(float)
    grouped = defaultdict(list)
    for event in events:
        if event["kind"] in ("buy", "sell", "grant"):
            grouped[event_key(event)].append(event)
    problems = []
    for key in set(expected) | set(grouped):
        trades = grouped[key]
        history = histories.get(key)
        if not trades or any(event.get("quantity") is None for event in trades):
            problems.append(f"{key[1]}: complete executed quantities are unavailable")
            continue
        if history is None or history.empty:
            problems.append(f"{key[1]}: price history is unavailable")
            continue
        balance = 0.0
        for event in sorted(trades, key=lambda e: (e["date"], e.get("timestamp", ""), e.get("sequence", 0))):
            balance += event["quantity"] * split_factor(history, event["date"])
            if balance < -max(1e-6, abs(expected.get(key, 0)) * 1e-5):
                problems.append(f"{key[1]}: sales precede recorded purchases")
                break
        quantities[key] = balance
        if not math.isclose(balance, expected.get(key, 0), rel_tol=1e-5, abs_tol=1e-6):
            logger.debug("%s quantity mismatch: executions=%s, current=%s, trades=%d",
                           key[1], balance, expected.get(key, 0), len(trades))
            problems.append(f"{key[1]}: transactions do not reconcile to current holdings")
    return problems


def benchmark_history(events, history, start, end):
    """Replay dated cash flows at the benchmark ETF's closing prices.

Cash received on closed market days waits until the next session. Withdrawals
are never capped or silently dropped; an unfundable strategy becomes unavailable.
"""
    if not events or history.empty:
        return {}, None, "Benchmark market history is unavailable." if events else None
    by_date = defaultdict(float)
    for event in events:
        by_date[event["date"]] -= event["amount"]
    shares = cash = 0.0
    last_price = None
    values = {}
    failed = False
    prices = history["Close"].to_dict()
    for key in pd.date_range(start, end).strftime("%Y-%m-%d"):
        cash += by_date[key]
        if key in prices:
            last_price = number(prices[key])
            if not failed and last_price:
                next_shares = shares + cash / last_price
                if next_shares < -1e-8:
                    failed = True
                else:
                    shares = max(0, next_shares)
                    cash = 0.0
        value = shares * last_price + cash if last_price else cash
        if value < -1e-6:
            failed = True
        values[key] = None if failed else value
    if failed:
        return values, None, f"Matching the withdrawals would exhaust the {BENCHMARK_SYMBOL} benchmark; its return is unavailable."
    terminal = values[str(end)]
    net = -sum(e["amount"] for e in events)
    return values, {
        "name": f"Vanguard S&P 500 ETF ({BENCHMARK_SYMBOL})", "symbol": BENCHMARK_SYMBOL,
        "currentValue": terminal, "investment": net,
        "profitLoss": terminal - net,
        "xirr": money_weighted_return(events, terminal, end),
        "asOf": history.index[-1],
    }, None


def biweekly_voo_values(trades, history, today):
    """Spread net purchases through yesterday over equal 14-day installments."""
    cutoff = today - timedelta(days=1)
    eligible = [trade for trade in trades if trade["date"] <= cutoff.isoformat()]
    first_buy = next((trade for trade in eligible if trade["kind"] == "buy"), None)
    total = -math.fsum(trade["amount"] for trade in eligible if trade["kind"] in ("buy", "sell"))
    if first_buy is None or total <= 0 or history.empty:
        return {}
    start = date.fromisoformat(first_buy["date"])
    # Keep the comparison unavailable when the fund lacks a price near the start.
    first_session = history.index.searchsorted(start.isoformat())
    if first_session >= len(history) or date.fromisoformat(history.index[first_session]) > start + timedelta(days=7):
        return {}
    dates = pd.date_range(start, today, freq="14D").strftime("%Y-%m-%d")
    payment = total / len(dates)
    installments = [{"date": day, "amount": -payment} for day in dates]
    values, _, _ = benchmark_history(installments, history, start, today)
    return values


def comparison_returns(rows, flows, today, portfolio_xirr, voo_xirr):
    """Measure each window from its opening closing mark and subsequent cash flows."""
    lifetime = {"portfolioXirr": portfolio_xirr, "vooXirr": voo_xirr}
    periods = {"All": lifetime}
    for label, months in (("1M", 1), ("3M", 3), ("1Y", 12)):
        boundary = (pd.Timestamp(today) - pd.DateOffset(months=months)).date().isoformat()
        if not rows or boundary <= rows[0]["date"]:
            periods[label] = lifetime
            continue
        opening = next((row for row in rows if row["date"] >= boundary), None)
        closing = rows[-1]
        if opening is None or opening["date"] >= closing["date"]:
            periods[label] = {"portfolioXirr": None, "vooXirr": None}
            continue
        window_flows = [flow for flow in flows if opening["date"] < flow["date"] <= closing["date"]]
        rates = {}
        for series, metric in (("portfolio", "portfolioXirr"), ("sp500", "vooXirr")):
            start, end = opening[series], closing[series]
            rates[metric] = (money_weighted_return(
                [{"date": opening["date"], "amount": -start}, *window_flows], end, closing["date"]
            ) if start is not None and end is not None else None)
        periods[label] = rates
    return periods


def historical_values(holdings, events, histories, benchmark, end, current_value, reconstruct=True):
    trades = [e for e in events if e["kind"] in ("buy", "sell", "grant")]
    if not events:
        return []
    start = min(e["date"] for e in events)
    by_date = defaultdict(list)
    for event in trades:
        by_date[event["date"]].append(event)
    days = pd.date_range(start, end).strftime("%Y-%m-%d")
    # Align prices once per asset instead of looking up each candle in the daily loop.
    prices = {key: histories[key]["Close"].reindex(days, method="ffill").to_numpy()
              for key in {event_key(event) for event in trades}} if reconstruct else {}
    balances = defaultdict(float)
    asset_types = {asset_key(h["symbol"], h["assetType"]): h["assetType"] for h in holdings}
    result = []
    net_investment = 0.0
    for index, key in enumerate(days):
        for event in by_date[key]:
            asset = event_key(event)
            net_investment -= event["amount"]
            if reconstruct:
                balances[asset] += event["quantity"] * split_factor(histories[asset], key)
        value = 0.0 if reconstruct else None
        breakdown = {"stock": 0.0, "etf": 0.0, "crypto": 0.0}
        for asset, quantity in balances.items():
            if quantity > 1e-6:
                price = number(prices[asset][index])
                if price is None:
                    value = None
                    break
                value += quantity * price
                breakdown[asset_types.get(asset, asset[0])] += quantity * price
        # A live valuation gets its own current date, never an earlier date.
        if key == str(end) and reconstruct:
            value = current_value
            for kind in breakdown:
                breakdown[kind] = sum(h["currentValue"] for h in holdings if h["assetType"] == kind) if value is not None else None
        result.append({"date": key, "portfolio": value, "sp500": benchmark.get(key),
                       "netInvestment": net_investment, "assets": breakdown if value is not None else None})
    return result


def period_move(history, current_price, days, today):
    if current_price is None or history.empty:
        return None
    target = str(today - timedelta(days=days))
    index = history.index.searchsorted(target, side="right") - 1
    if index < 0:
        return None
    return (current_price / float(history["Close"].iat[index]) - 1) * 100


def holding_duration(start, end):
    if start > end:
        return "Unavailable"
    months = (end.year - start.year) * 12 + end.month - start.month
    anchor = end.replace(day=min(start.day, monthrange(end.year, end.month)[1]))
    if anchor > end:
        last_day = end.replace(day=1) - timedelta(days=1)
        anchor = last_day.replace(day=min(start.day, last_day.day))
        months -= 1
    years, months = divmod(months, 12)
    days = (end - anchor).days
    parts = [f"{amount:,} {unit}{'' if amount == 1 else 's'}"
             for amount, unit in ((years, "year"), (months, "month"), (days, "day")) if amount]
    return ", ".join(parts) or "0 days"


def monthly_contributions(holdings, events, histories, today):
    """Dollar P&L by symbol between successive month-end valuations."""
    if not events:
        return []
    flows = defaultdict(lambda: defaultdict(list))
    for event in return_cash_flows(events):
        flows[event["date"][:7]][event_key(event)].append(event)
    current = {asset_key(h["symbol"], h["assetType"]): h["currentValue"] for h in holdings}
    asset_types = {event_key(e): e["assetType"] for e in events if e.get("assetType") == "etf"}
    asset_types.update({asset_key(h["symbol"], h["assetType"]): h["assetType"] for h in holdings})
    balances, previous = defaultdict(float), {}
    empty_history = daily_history(None)
    report = []
    for period in pd.period_range(events[0]["date"], today, freq="M"):
        month = str(period)
        last_day = min(period.end_time.date(), today)
        trades = flows[month]
        rows = []
        for key in sorted(set(previous) | set(trades)):
            history = histories.get(key, empty_history)
            events_in_month = trades.get(key, [])
            start_value = previous.get(key, 0.0)
            for event in events_in_month:
                if event["kind"] in ("buy", "sell", "grant"):
                    balances[key] += event["quantity"] * split_factor(history, event["date"])
            end_value = 0.0
            if last_day == today:
                end_value = current.get(key, 0.0)
            elif balances[key] > 1e-10:
                index = history.index.searchsorted(last_day.isoformat(), side="right") - 1
                end_value = number(history["Close"].iat[index] * balances[key]) if index >= 0 else None
            contribution = (end_value - start_value + math.fsum(e["amount"] for e in events_in_month)
                            if end_value is not None and start_value is not None else None)
            rows.append({"symbol": key[1], "assetType": asset_types.get(key, key[0]), "value": contribution})
            if end_value == 0 and balances[key] <= 1e-10:
                previous.pop(key, None)
            else:
                previous[key] = end_value
        report.append({"month": month, "assets": rows})
    return report


def calculate_portfolio(holdings, events, histories, benchmark_prices, today=None,
                        ledger_complete=True, valuation_complete=True, warnings=None,
                        income_complete=None, trade_completeness=None, *, include_monthly=True):
    today = today or date.today()
    income_complete = ledger_complete if income_complete is None else income_complete
    trade_completeness = trade_completeness or {"stock": ledger_complete, "crypto": ledger_complete}
    events = sorted(events, key=lambda e: (e["date"], e.get("timestamp", ""), e.get("sequence", 0)))
    warnings = list(warnings or [])
    histories = {key: daily_history(frame) for key, frame in histories.items()}
    benchmark_prices = daily_history(benchmark_prices)
    by_asset = defaultdict(list)
    for event in events:
        by_asset[event_key(event)].append(event)
    problems = reconcile_positions(holdings, events, histories)
    if problems:
        warnings.extend(problems)
    complete = ledger_complete and not problems
    valued = valuation_complete and all(h.get("currentValue") is not None for h in holdings)
    current_value = sum(h["currentValue"] for h in holdings) if valued else None
    dividends = [e for e in events if e["kind"] == "dividend"]
    unknown_dividend_assets = {event_key(e) for e in dividends if not e.get("reinvestmentKnown", False)}
    dividend_split_known = income_complete and not unknown_dividend_assets
    stocks = []
    for holding in holdings:
        stock = dict(holding)
        key = asset_key(stock["symbol"], stock["assetType"])
        basis = stock.get("costBasis")
        value = stock.get("currentValue")
        pnl = value - basis if value is not None and basis is not None else None
        own_events = by_asset[key]
        history = histories.get(key)
        if history is None:
            history = daily_history(None)
        # The current holding period starts after the last complete liquidation.
        balance = 0.0
        start_date = None
        for event in own_events:
            if event["kind"] not in ("buy", "sell", "grant") or event.get("quantity") is None:
                continue
            if event["kind"] in ("buy", "grant") and balance <= 1e-6:
                start_date = event["date"]
            balance += event["quantity"] * split_factor(history, event["date"])
        positions_complete = trade_completeness[key[0]] and not reconcile_positions([holding], own_events, {key: history})
        own_complete = (positions_complete and key not in unknown_dividend_assets
                        and (income_complete or key[0] == "crypto"))
        own_flows = return_cash_flows(own_events) if own_complete else []
        purchases = -math.fsum(event["amount"] for event in own_flows if event["kind"] == "buy")
        total_return = ((value + math.fsum(event["amount"] for event in own_flows)) / purchases * 100
                        if value is not None and purchases > 0 else None)
        stock.update({
            "investment": basis, "profitLoss": pnl,
            "returnPct": pnl / basis * 100 if pnl is not None and basis and basis > 0 else None,
            "netInvested": -sum(e["amount"] for e in own_events if e["kind"] != "dividend"),
            "totalReturnPct": total_return,
            "xirr": money_weighted_return(own_flows, value, today) if own_complete else None,
            "timeHeld": holding_duration(date.fromisoformat(start_date), today)
                        if start_date and positions_complete else "Unavailable",
            "timeHeldDays": (today - date.fromisoformat(start_date)).days if start_date and positions_complete else None,
            "week": period_move(history, stock.get("currentPrice"), 7, today),
            "month": period_move(history, stock.get("currentPrice"), 30, today),
            "previousClose": number(history.loc[history.index < str(today), "Close"].iloc[-1])
                             if any(history.index < str(today)) else None,
        })
        stocks.append(stock)
    trades = [e for e in events if e["kind"] != "dividend"]
    income = sum(e["amount"] for e in dividends)
    paid_dividends = sum(e["amount"] for e in dividends if not e.get("reinvested")) if dividend_split_known else None
    grants = [e for e in events if e["kind"] == "grant"]
    reward_value = sum(e["rewardValue"] for e in grants) if all(e.get("rewardValue") is not None for e in grants) else None
    net_investment = -sum(e["amount"] for e in trades)
    total_pnl = (current_value - net_investment + paid_dividends
                 if complete and valued and paid_dividends is not None else None)
    if complete and not dividend_split_known:
        warnings.append("Current P&L and portfolio XIRR are unavailable because Robinhood did not confirm which dividends were reinvested.")
    unrealized = sum(s["profitLoss"] for s in stocks) if valued and all(s["profitLoss"] is not None for s in stocks) else None
    # Reward receipt values are informational: the delivered shares already
    # contribute to current value and the broker's unrealized return. Subtracting
    # their receipt value again would invent a realized trading loss.
    realized = (current_value - net_investment - unrealized
                if complete and valued and unrealized is not None else None)
    if realized is not None:
        realized = round(realized, 2) or 0.0  # Do not report floating-point residue as -$0.00.
    start = min((e["date"] for e in events), default=str(today))
    overall, benchmark, sp500 = None, {}, None
    period_returns = {}
    if complete and dividend_split_known:
        flows = return_cash_flows(events)
        overall = money_weighted_return(flows, current_value, today)
        benchmark, sp500, note = benchmark_history(flows, benchmark_prices, start, today)
        if note:
            warnings.append(note)
    history = historical_values(stocks, events, histories, benchmark, today, current_value, complete)
    if complete and dividend_split_known:
        period_returns = comparison_returns(history, flows, today, overall, sp500["xirr"] if sp500 else None)
    weights = [(s["currentValue"] or 0) / current_value for s in stocks] if current_value else []
    sectors = defaultdict(float)
    stock_sectors = defaultdict(float)
    for stock in stocks:
        sector = stock.get("sector") or "Uncategorized"
        value = stock["currentValue"] or 0
        sectors[sector] += value
        if stock["assetType"] == "stock" and sector != "Uncategorized" and value > 0:
            stock_sectors[sector] += value
    largest_sector = max(stock_sectors, key=stock_sectors.get, default=None)
    ranked = [s for s in stocks if s["returnPct"] is not None] if valuation_complete else []
    best = max(ranked, key=lambda s: s["returnPct"], default=None)
    worst = min(ranked, key=lambda s: s["returnPct"], default=None)
    largest = max(stocks, key=lambda s: s["currentValue"] or 0, default=None)
    insights = {
        "alpha": overall - sp500["xirr"] if overall is not None and sp500 and sp500["xirr"] is not None else None,
        "diversification": round(1 / sum(w * w for w in weights), 1) if any(weights) else None,
        "largestPosition": {"symbol": largest["symbol"], "weight": max(weights) * 100} if largest and weights else None,
        "topSector": max(sectors, key=sectors.get) if sectors and valued else None,
        "largestStockSector": {"name": largest_sector, "weight": stock_sectors[largest_sector] / current_value * 100}
                              if largest_sector and current_value and current_value > 0 else None,
        "bestPerformer": {"symbol": best["symbol"], "returnPct": best["returnPct"]} if best else None,
        "worstPerformer": {"symbol": worst["symbol"], "returnPct": worst["returnPct"]} if worst else None,
        "unrealizedGains": unrealized, "realizedGains": realized, "stockRewards": reward_value,
    }
    return {
        "stocks": stocks, "sp500": sp500,
        "historicalData": history, "comparisonReturns": period_returns,
        "vooSip": biweekly_voo_values(trades, benchmark_prices, today) if complete else {},
        "historyNote": "Daily securities values reconstructed from executions and split-adjusted prices."
                       if complete else "Portfolio history and lifetime returns are unavailable because the recorded transactions cannot be reconciled. Net trade investment is shown separately.",
        "cashFlowTransactions": events, "asOf": today.isoformat(),
        "monthlyContributions": monthly_contributions(stocks, events, histories, today)
                                if include_monthly and complete and valued and dividend_split_known else None,
        "tradeHistoryComplete": bool(trade_completeness.get("stock") and trade_completeness.get("crypto")),
        "totalInvestment": net_investment if complete else None,
        "totalCostBasis": sum(s["costBasis"] for s in stocks) if all(s.get("costBasis") is not None for s in stocks) else None,
        "totalCurrentValue": current_value, "totalProfitLoss": total_pnl, "overallXirr": overall,
        "dividends": {"received": income if income_complete else None,
                      "paid": paid_dividends,
                      "reinvested": sum(e["amount"] for e in dividends if e.get("reinvested"))
                      if dividend_split_known else None},
        "insights": insights, "accountingComplete": complete, "valuationComplete": valued,
        "warnings": list(dict.fromkeys(warnings)),
    }
