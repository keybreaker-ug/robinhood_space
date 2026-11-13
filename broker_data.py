"""Read-only broker and market adapters. No order placement APIs are exposed."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import logging
import threading
import time
from urllib.parse import urlsplit

import pandas as pd
import robin_stocks.robinhood as rh
import yfinance as yf

from analytics import BENCHMARK_SYMBOL, asset_key, calculate_portfolio, daily_history, number, split_factor

_cache = {}
_cache_lock = threading.Lock()
_instrument_cache = {}
logger = logging.getLogger(__name__)
BROKER_TIME_ZONE = "America/New_York"


def money(value):
    """Robinhood uses both scalar amounts and currency-tagged amount objects."""
    if isinstance(value, dict):
        return number(value.get("amount"))
    if isinstance(value, list):
        amounts = [money(item) for item in value]
        return sum(amounts) if all(item is not None for item in amounts) else None
    return number(value)


def brokerage_day(timestamp):
    """Use one calendar for execution, income, and current valuation dates."""
    instant = pd.Timestamp(timestamp)
    if pd.isna(instant):
        raise ValueError("Missing cash flow date")
    if instant.tzinfo is not None:
        instant = instant.tz_convert(BROKER_TIME_ZONE)
    return instant.date().isoformat()


def transaction_history(url):
    """Read every page or fail so an incomplete ledger cannot produce returns."""
    broker_host = urlsplit(url).netloc
    records, seen = [], set()
    while url is not None:
        page_url = urlsplit(url)
        if page_url.scheme != "https" or page_url.netloc != broker_host or url in seen:
            raise ValueError("Invalid Robinhood history page")
        seen.add(url)
        response = rh.helper.SESSION.get(url, timeout=(5, 20), allow_redirects=False)
        if response.status_code != 200:
            raise ValueError("Robinhood history page is unavailable")
        page = response.json()
        batch, url = page["results"], page["next"]
        if not isinstance(batch, list) or any(not isinstance(item, dict) for item in batch):
            raise ValueError("Invalid Robinhood history records")
        records.extend(batch)
    return records


def sweep_data(endpoint, account_number, **params):
    """Read a cash-sweep summary for the selected Robinhood brokerage account."""
    try:
        response = rh.helper.SESSION.get(
            f"https://api.robinhood.com/accounts/sweeps/{endpoint}/",
            params={"account_number": account_number, **params},
            timeout=(3, 6), allow_redirects=False,
        )
        if response.status_code == 200:
            payload = response.json()
            if isinstance(payload, dict) and payload.get("account_number", account_number) == account_number:
                return payload
    except Exception as error:
        logger.warning("Robinhood cash sweep read failed (%s)", type(error).__name__)
    return {}


def cash_summary():
    summary = {"balance": None, "interestEarned": None, "apy": None}
    try:
        profile = rh.profiles.load_account_profile()
    except Exception as error:
        logger.warning("Robinhood brokerage cash is unavailable (%s)", type(error).__name__)
        return summary
    if not isinstance(profile, dict):
        return summary
    summary["balance"] = money(profile.get("portfolio_cash"))
    if summary["balance"] is None:
        summary["balance"] = money(profile.get("cash"))
    account_number = profile.get("account_number")
    if not account_number:
        return summary

    timeline = sweep_data("timeline_summary", account_number, datetime=datetime.now(timezone.utc).isoformat())
    summary["interestEarned"] = money(timeline.get("total_paid_interest"))
    if profile.get("sweep_enrolled") is False:
        summary["apy"] = 0.0
    else:
        # This account-scoped field is already a percentage. The other fields
        # in the response describe rates for different plans and promotions.
        rates = sweep_data("interest", account_number)
        apy = number(rates.get("interest_rate"))
        if apy is not None and apy >= 0:
            summary["apy"] = apy
    return summary


def execution_notional(execution):
    amount = money(execution.get("rounded_notional"))
    if amount is None:
        amount = money(execution.get("notional"))
    if amount is None:
        quantity = number(execution.get("quantity"))
        price = number(execution.get("price")) or number(execution.get("effective_price"))
        amount = price * quantity if price is not None and quantity is not None else None
    return amount


def cached(key, loader, seconds=900):
    with _cache_lock:
        item = _cache.get(key)
        if item and time.monotonic() - item[0] < seconds:
            return item[1]
    value = loader()
    with _cache_lock:
        if len(_cache) > 512:
            _cache.clear()
        _cache[key] = (time.monotonic(), value)
    return value


def instrument_details(url):
    if not url:
        raise ValueError("An executed transaction has no instrument.")
    with _cache_lock:
        instrument = _instrument_cache.get(url)
    if instrument is None:
        payload = rh.stocks.get_instrument_by_url(url) or {}
        symbol = payload.get("symbol")
        if not symbol:
            raise ValueError("Could not resolve a traded instrument.")
        kind = "etf" if str(payload.get("type", "")).lower() in ("etp", "etf") else "stock"
        instrument = (symbol.upper(), payload.get("simple_name") or payload.get("name") or symbol, kind)
        with _cache_lock:
            _instrument_cache[url] = instrument
    return instrument


def instrument_symbol(url):
    return instrument_details(url)[0]


def stock_holdings():
    raw = rh.account.get_open_stock_positions()
    if not isinstance(raw, list) or any(not isinstance(position, dict) for position in raw):
        raise ValueError("Robinhood stock holdings are unavailable. Please refresh or sign in again.")
    positions = []
    for item in raw:
        quantity = number(item.get("quantity"))
        if quantity is None:
            raise ValueError("Robinhood returned an invalid stock holding quantity.")
        if quantity > 0:
            positions.append((item.get("instrument"), quantity, number(item.get("average_buy_price"))))
    if not positions:
        return []
    urls = list(dict.fromkeys(url for url, _, _ in positions))
    with ThreadPoolExecutor(max_workers=6) as pool:
        instruments = dict(zip(urls, pool.map(instrument_details, urls)))
    symbols = list(dict.fromkeys(symbol for symbol, _, _ in instruments.values()))
    prices = {}
    # Quotes carry their symbol. Match by symbol because Robinhood can omit or reorder rows.
    batch_size = 50
    for offset in range(0, len(symbols), batch_size):
        try:
            quotes = rh.stocks.get_quotes(symbols[offset:offset + batch_size])
        except Exception as error:
            logger.warning("Robinhood stock quote batch failed (%s)", type(error).__name__)
            continue
        for quote in quotes or []:
            if isinstance(quote, dict) and quote.get("symbol"):
                regular_price = number(quote.get("last_trade_price"))
                price = number(quote.get("last_extended_hours_trade_price"), regular_price)
                prices[quote["symbol"].upper()] = (price, number(quote.get("previous_close")))
    result = {}
    for url, quantity, average in positions:
        symbol, name, kind = instruments[url]
        price, previous = prices.get(symbol, (None, None))
        result[symbol] = {"symbol": symbol, "name": name, "quantity": quantity, "avgCost": average,
                          "costBasis": quantity * average if average is not None else None,
                          "currentPrice": price, "currentValue": round(quantity * price, 2) if price is not None else None,
                          "previousClose": previous, "assetType": kind, "sector": "Uncategorized", "isEtf": kind == "etf"}
    return list(result.values())


def crypto_holdings():
    raw = rh.crypto.get_crypto_positions()
    if not isinstance(raw, list) or any(not isinstance(p, dict) for p in raw):
        raise ValueError("Robinhood crypto holdings are unavailable.")
    positions = []
    for position in raw:
        currency = position.get("currency") or {}
        symbol = currency.get("code") or position.get("currency_code")
        quantity = number(position.get("quantity"))
        if quantity is None:
            available = number(position.get("quantity_available"))
            reserved = number(position.get("quantity_held_for_sell"), 0)
            quantity = available + reserved if available is not None else None
        if not symbol or quantity is None:
            raise ValueError("Robinhood returned an incomplete crypto holding.")
        if quantity <= 0:
            continue
        bases = position.get("cost_bases") or []
        average = None
        if bases:
            costs = [number(row.get("direct_cost_basis", row.get("cost_basis"))) for row in bases]
            quantities = [number(row.get("direct_quantity", row.get("quantity"))) for row in bases]
            if all(v is not None for v in costs + quantities) and sum(quantities) > 0:
                average = sum(costs) / sum(quantities)
        elif number(position.get("cost_basis")) is not None:
            average = number(position["cost_basis"]) / quantity
        positions.append((symbol, currency.get("name") or symbol, quantity, average))

    def with_quote(position):
        symbol, name, quantity, average = position
        try:
            quote = rh.crypto.get_crypto_quote(symbol) or {}
            price = number(quote.get("mark_price")) or number(quote.get("ask_price"))
        except Exception:
            price = None
        return {"symbol": symbol.upper(), "name": name, "quantity": quantity, "avgCost": average,
                "costBasis": quantity * average if average is not None else None,
                "currentPrice": price, "currentValue": quantity * price if price else None,
                "assetType": "crypto", "sector": "Crypto", "isEtf": False}

    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(with_quote, positions))


def normalize_trades(orders, asset_type="stock", symbol_resolver=None):
    """Count executions even on partially filled/cancelled orders, exactly once."""
    result, warnings, seen = [], [], set()
    logged_errors = set()
    for order_index, order in enumerate(orders):
        executions = order.get("executions") or []
        # Aggregate executed quantities are safe only when the API supplies them;
        # requested quantity/notional on an unfilled order is not an execution.
        if not executions and asset_type == "crypto":
            quantity = number(order.get("cumulative_quantity"), 0)
            if quantity > 0:
                executions = [{"quantity": quantity, "price": order.get("average_price"),
                               "timestamp": order.get("last_transaction_at") or order.get("updated_at"),
                               "rounded_notional": order.get("executed_notional")}]
        if not executions:
            if order.get("state") == "filled" or number(order.get("cumulative_quantity"), 0) > 0:
                warnings.append("Some filled orders have no execution details; lifetime returns are unavailable.")
            continue
        try:
            if asset_type == "stock":
                symbol = (symbol_resolver or instrument_symbol)(order.get("instrument"))
            else:
                currency = order.get("currency") or {}
                symbol = currency.get("code") or order.get("symbol") or order.get("currency_code")
                if not symbol and order.get("currency_pair_id"):
                    pairs = cached(("crypto_pairs",), lambda: rh.crypto.get_crypto_currency_pairs(), 86400)
                    pair = next((p for p in pairs or [] if p.get("id") == order["currency_pair_id"]), {})
                    symbol = (pair.get("asset_currency") or {}).get("code")
                if symbol and symbol.upper().endswith("-USD"):
                    symbol = symbol[:-4]
            side = order.get("side", "").lower()
            if not symbol or side not in ("buy", "sell"):
                raise ValueError("Missing symbol or side")
            fee = money(order.get("fees")) or 0
            notionals = [execution_notional(execution) for execution in executions]
            if any(amount is None or amount <= 0 for amount in notionals):
                raise ValueError("Missing executed value")
            gross_total = sum(notionals)
            charged_total = None
            if asset_type == "crypto":
                # The cash ledger is rounded at order level. Use the reported
                # final cash amount instead of accumulating sub-cent fill values
                # or adding fees a second time.
                charged_total = money(order.get("rounded_executed_notional_with_fee"))
                if charged_total is None:
                    gross_rounded = money(order.get("rounded_executed_notional"))
                    if gross_rounded is not None:
                        charged_total = gross_rounded + fee if side == "buy" else gross_rounded - fee
            for index, execution in enumerate(executions):
                execution_id = (asset_type, execution.get("id") or f"{order.get('id', order_index)}:{index}")
                if execution_id in seen:
                    continue
                timestamp = execution.get("timestamp") or execution.get("created_at") or order.get("last_transaction_at")
                day = brokerage_day(timestamp)
                quantity = number(execution.get("quantity"))
                amount = notionals[index]
                execution_fee = fee * amount / gross_total
                cash = (amount + execution_fee if side == "buy" else amount - execution_fee)
                if charged_total is not None:
                    cash = charged_total * amount / gross_total
                result.append({"symbol": symbol.upper(), "assetType": asset_type, "date": day,
                               "timestamp": str(timestamp),
                               "kind": side, "quantity": quantity * (1 if side == "buy" else -1) if quantity is not None else None,
                               "amount": -cash if side == "buy" else cash,
                               "sequence": order_index * 10000 + index})
                seen.add(execution_id)
        except Exception as exc:
            signature = (type(exc).__name__, str(exc))
            if signature not in logged_errors:
                logger.warning("Unreadable %s execution: %s; order fields=%s; execution fields=%s",
                               asset_type, exc, sorted(order),
                               [sorted(e) for e in executions[:1] if isinstance(e, dict)])
                logged_errors.add(signature)
            warnings.append("Some executed transactions could not be read; lifetime returns are unavailable.")
    return result, warnings


def dividend_events(dividends, symbol_resolver=None):
    result, warnings, seen = [], [], set()
    for item in dividends:
        if str(item.get("state", "")).lower() not in ("paid", "reinvested"):
            continue
        try:
            event_id = item.get("id")
            if event_id and event_id in seen:
                continue
            day = brokerage_day(item.get("paid_at") or item.get("payable_date"))
            amount = number(item.get("amount"))
            if amount is None:
                raise ValueError("Missing dividend amount")
            # Current responses distinguish the credited amount from gross_amount.
            # Retain legacy handling for responses that supply only a gross amount.
            if "gross_amount" not in item:
                amount -= number(item.get("withholding"), 0) + number(item.get("nra_withholding"), 0)
            symbol = item.get("symbol") or (symbol_resolver or instrument_symbol)(item.get("instrument"))
            state = str(item.get("state", "")).lower()
            drip_state = str(item.get("drip_order_state") or "").lower()
            reinvested = item.get("reinvested") in (True, "true") or state == "reinvested" or drip_state == "filled"
            # An enabled preference alone does not confirm execution. A skipped
            # or failed DRIP on a paid dividend confirms it remained cash.
            known = (reinvested or item.get("reinvested") in (False, "false")
                     or item.get("drip_enabled") in (False, "false")
                     or bool(item.get("drip_skipped_reason"))
                     or drip_state in ("cancelled", "canceled", "failed", "rejected"))
            result.append({"symbol": symbol.upper(), "assetType": "stock", "date": day,
                           "amount": amount, "quantity": 0, "kind": "dividend", "reinvested": reinvested,
                           "reinvestmentKnown": known})
            if event_id:
                seen.add(event_id)
        except Exception:
            warnings.append("Some paid dividends could not be read; lifetime returns are unavailable.")
    return result, warnings


def stock_reward_events(referrals):
    """Only delivered stock rewards, with no fabricated cash purchase."""
    events, seen = [], set()
    for referral in referrals or []:
        if not isinstance(referral, dict):
            continue
        for index, stock in enumerate((referral.get("reward") or {}).get("stocks") or []):
            timestamp = stock.get("received_at")
            quantity = number(stock.get("quantity"))
            symbol = stock.get("symbol")
            if not timestamp or not symbol or not quantity or quantity <= 0:
                continue
            if stock.get("state") in ("cancelled", "canceled", "rescinded", "reversed"):
                continue
            identity = stock.get("uuid") or f"{referral.get('id')}:{index}"
            if identity in seen:
                continue
            # Referral reward cost_basis is the total delivered lot value.
            reward_basis = money(stock.get("cost_basis"))
            events.append({"symbol": symbol.upper(), "assetType": "stock", "date": brokerage_day(timestamp),
                           "timestamp": str(timestamp), "kind": "grant", "quantity": quantity, "amount": 0.0,
                           "rewardValue": reward_basis})
            seen.add(identity)
    return events


def include_stock_rewards(holdings, events, rewards, histories):
    """Use confirmed awards to explain missing shares, without duplicating orders."""
    expected = {asset_key(h["symbol"], h["assetType"]): h["quantity"] for h in holdings}
    additions = []
    for key in {asset_key(e["symbol"]) for e in rewards}:
        history = daily_history(histories.get(key))
        if history.empty:
            continue
        recorded = sum(e["quantity"] * split_factor(history, e["date"]) for e in events
                       if asset_key(e["symbol"], e["assetType"]) == key and e.get("quantity") is not None)
        gap = expected.get(key, 0) - recorded
        tolerance = max(1e-6, abs(expected.get(key, 0)) * 1e-5)
        if abs(gap) <= tolerance:
            continue
        matching = [e for e in rewards if asset_key(e["symbol"]) == key]
        awarded = sum(e["quantity"] * split_factor(history, e["date"]) for e in matching)
        if gap > 0 and awarded <= gap + tolerance:
            additions.extend(matching)
    return events + additions


def market_history(key, start, today):
    kind, symbol = key
    ticker = f"{symbol}-USD" if kind == "crypto" else symbol.replace(".", "-")
    def load():
        frame = yf.Ticker(ticker).history(start=str(start), end=str(today + timedelta(days=1)),
                                           auto_adjust=False, actions=True, timeout=15)
        if frame.empty:
            raise ValueError(f"{symbol}: no price history")
        return frame
    return cached(("history", ticker, str(start), str(today)), load, 300)


def metadata(symbol, fallback):
    def load():
        info = yf.Ticker(symbol).info or {}
        etf = str(info.get("quoteType", "")).upper() == "ETF"
        sector = info.get("sector") or info.get("category")
        sector = sector.strip() if isinstance(sector, str) else "Uncategorized"
        return {"sector": sector or "Uncategorized",
                "isEtf": etf, "assetType": "etf" if etf else "stock",
                "trailingPE": number(info.get("trailingPE")), "marketCap": number(info.get("marketCap")),
                "high52": number(info.get("fiftyTwoWeekHigh")), "low52": number(info.get("fiftyTwoWeekLow"))}
    try:
        return cached(("metadata", symbol), load, 86400)
    except Exception:
        # A temporary request failure must not become a permanent cached category.
        return {"sector": "Uncategorized", "isEtf": False, "assetType": "stock"}


def return_risk_metrics(returns):
    std = returns.std()
    cumulative = pd.concat([pd.Series([1.0]), (1 + returns).cumprod()], ignore_index=True)
    return {"volatility": number(std * 252 ** .5 * 100),
            "drawdown": number(((cumulative / cumulative.cummax()) - 1).min() * 100),
            "sharpe": number(returns.mean() / std * 252 ** .5) if std > 0 else None}


def risk_metrics(stocks, histories, benchmark, *, valuation_complete=True):
    missing = {"volatility": None, "drawdown": None, "sharpe": None, "beta": None, "alpha": None, "benchmark": None,
               "note": "Risk estimates need current values for all holdings and at least 30 shared trading intervals with VOO."}
    positions = [(asset_key(s["symbol"], s["assetType"]), number(s.get("currentValue"))) for s in stocks]
    if not valuation_complete or any(value is None or value < 0 for _, value in positions):
        return missing
    total = sum(value for _, value in positions)
    if total <= 0:
        return missing
    try:
        benchmark_history = daily_history(benchmark).tail(253)
        benchmark_prices = pd.to_numeric(benchmark_history.get("Adj Close", benchmark_history["Close"]), errors="coerce")
        market = benchmark_prices.where(benchmark_prices > 0).pct_change(fill_method=None)
        weighted_returns = []
        for key, value in positions:
            if not value:
                continue
            history = daily_history(histories.get(key))
            if history.empty:
                return missing
            # Sample prices before calculating returns so Friday-to-Monday crypto moves are included.
            sampled = history.reindex(market.index)
            close = sampled["Close"]
            dividends = sampled["Dividends"].fillna(0) if "Dividends" in sampled else 0.0
            returns = (close + dividends).div(close.shift(1)) - 1
            weighted_returns.append(returns * (value / total))
        basket = pd.concat(weighted_returns, axis=1).sum(axis=1, min_count=len(weighted_returns))
        aligned = pd.concat([basket.rename("portfolio"), market.rename("market")], axis=1).dropna()
        if len(aligned) < 30:
            return missing
        variance = aligned.market.var()
        beta = number(aligned.portfolio.cov(aligned.market) / variance) if variance > 0 else None
        # Jensen's alpha is the regression intercept with a 0% risk-free rate.
        alpha = number((aligned.portfolio.mean() - beta * aligned.market.mean()) * 252 * 100) if beta is not None else None
        return {**return_risk_metrics(aligned.portfolio),
                "benchmark": return_risk_metrics(aligned.market),
                "beta": beta, "alpha": alpha,
                "note": f"The VOO comparison uses {len(aligned)} shared trading days and today’s weights across stocks, ETFs, and crypto, "
                        "with rebalancing assumed at each interval. Crypto moves across weekends and holidays roll into the next VOO trading interval. "
                        "Cash is excluded. Alpha and Sharpe use a 0% risk-free rate."}
    except (ValueError, KeyError, TypeError):
        return missing


def collect_portfolio(today=None):
    today = today or pd.Timestamp.now(tz=BROKER_TIME_ZONE).date()
    warnings = []
    valuation_complete = ledger_complete = income_complete = True
    trade_completeness = {"stock": True, "crypto": True}
    # The API keeps the broker session locked through the refresh. Independent
    # reads can overlap without letting another account replace that session.
    with ThreadPoolExecutor(max_workers=7) as pool:
        stocks_job = pool.submit(stock_holdings)
        crypto_job = pool.submit(crypto_holdings)
        orders_job = pool.submit(transaction_history, rh.urls.orders_url())
        crypto_orders_job = pool.submit(transaction_history, rh.urls.crypto_orders_url())
        dividends_job = pool.submit(transaction_history, rh.urls.dividends_url())
        rewards_job = pool.submit(rh.account.get_referrals)
        cash_job = pool.submit(cash_summary)
        holdings = stocks_job.result()
        try:
            holdings.extend(crypto_job.result())
        except Exception:
            valuation_complete = False
            warnings.append("Crypto holdings could not be retrieved. Combined portfolio totals are unavailable.")
        try:
            raw_orders = orders_job.result()
        except Exception:
            raw_orders = []
            ledger_complete = trade_completeness["stock"] = False
            warnings.append("Stock and ETF transaction history is unavailable; lifetime returns are unavailable.")
        urls = {order["instrument"] for order in raw_orders if order.get("executions") and order.get("instrument")}
        with _cache_lock:
            urls.difference_update(_instrument_cache)
        futures = [pool.submit(instrument_symbol, url) for url in urls]
        for future in futures:
            try:
                future.result()
            except Exception:
                pass  # normalize_trades records the incomplete execution explicitly.
    events, issues = normalize_trades(list(reversed(raw_orders)))
    warnings.extend(issues)
    ledger_complete &= not issues
    trade_completeness["stock"] &= not issues
    try:
        crypto_orders = crypto_orders_job.result()
        additions, issues = normalize_trades(list(reversed(crypto_orders)), "crypto")
        events.extend(additions)
        warnings.extend(issues)
        ledger_complete &= not issues
        trade_completeness["crypto"] = not issues
    except Exception:
        ledger_complete = False
        trade_completeness["crypto"] = False
        warnings.append("Crypto transaction history is unavailable; lifetime returns are unavailable.")
    try:
        dividends = dividends_job.result()
        additions, issues = dividend_events(dividends)
        events.extend(additions)
        warnings.extend(issues)
        ledger_complete &= not issues
        income_complete = not issues
    except Exception:
        ledger_complete = False
        income_complete = False
        warnings.append("Dividend history is unavailable; lifetime returns are unavailable.")
    try:
        rewards = stock_reward_events(rewards_job.result())
        rewards = [e for e in rewards if e["date"] <= str(today)]
    except Exception:
        rewards = []  # A missing award still produces an explicit reconciliation warning.
    if any(e["date"] > str(today) for e in events):
        events = [e for e in events if e["date"] <= str(today)]
        ledger_complete = False
        warnings.append("Future-dated transactions were ignored; check the machine's date.")
        trade_completeness = {"stock": False, "crypto": False}
        income_complete = False
    return (holdings, events, rewards, today, warnings, ledger_complete, valuation_complete,
            income_complete, trade_completeness, cash_job.result())


def complete_portfolio(holdings, events, rewards, today, warnings, ledger_complete, valuation_complete,
                       income_complete, trade_completeness, cash, *, include_monthly=True):
    keys = {asset_key(h["symbol"], h["assetType"]) for h in holdings}
    keys.update(asset_key(e["symbol"], e["assetType"]) for e in events if e["kind"] != "dividend")
    keys.update(asset_key(e["symbol"]) for e in rewards)
    earliest = min([date.fromisoformat(e["date"]) for e in events + rewards] + [today - timedelta(days=370)])
    histories = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {key: pool.submit(market_history, key, earliest, today) for key in keys}
        benchmark_key = asset_key(BENCHMARK_SYMBOL)
        benchmark_job = jobs.get(benchmark_key)
        if benchmark_job is None:
            benchmark_job = pool.submit(market_history, benchmark_key, earliest, today)
        metadata_jobs = {h["symbol"]: pool.submit(metadata, h["symbol"], h["name"])
                         for h in holdings if h["assetType"] != "crypto"}
        for key, future in jobs.items():
            try:
                histories[key] = future.result()
            except Exception:
                warnings.append(f"{key[1]}: market history is unavailable.")
        for holding in holdings:
            if holding["assetType"] != "crypto":
                details = metadata_jobs[holding["symbol"]].result()
                if holding["assetType"] == "etf" and not details.get("isEtf"):
                    details = {**details, "assetType": "etf", "isEtf": True}
                holding.update(details)
            if holding["currentValue"] is None:
                warnings.append(f"{holding['symbol']}: current valuation is unavailable.")
            if holding["costBasis"] is None:
                warnings.append(f"{holding['symbol']}: remaining cost basis is unavailable.")
        try:
            benchmark = benchmark_job.result()
        except Exception:
            benchmark = pd.DataFrame()
    events = include_stock_rewards(holdings, events, rewards, histories)
    data = calculate_portfolio(holdings, events, histories, benchmark, today,
                               ledger_complete, valuation_complete, warnings,
                               income_complete=income_complete, trade_completeness=trade_completeness,
                               include_monthly=include_monthly)
    data["insights"]["risk"] = risk_metrics(data["stocks"], histories, benchmark,
                                             valuation_complete=data["valuationComplete"])
    data["cashSummary"] = cash
    return data


def load_portfolio(today=None):
    return complete_portfolio(*collect_portfolio(today))


def safe_url(value):
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    return value if parts.scheme in ("http", "https") and parts.netloc else None


def normalize_news(items):
    result, links, titles = [], set(), set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        content = item.get("content") or item
        if not isinstance(content, dict):
            continue
        link = None
        for key in ("canonicalUrl", "clickThroughUrl", "link"):
            candidate = content.get(key)
            link = safe_url(candidate.get("url") if isinstance(candidate, dict) else candidate)
            if link:
                break
        title = content.get("title")
        if not isinstance(title, str) or not title.strip() or not link:
            continue
        title_key = " ".join(title.casefold().split())
        if link in links or title_key in titles:
            continue
        links.add(link)
        titles.add(title_key)
        provider = content.get("provider")
        publisher = provider.get("displayName") if isinstance(provider, dict) else content.get("publisher")
        published = content.get("pubDate") or content.get("providerPublishTime")
        try:
            timestamp = (datetime.fromisoformat(published.replace("Z", "+00:00")) if isinstance(published, str)
                         else datetime.fromtimestamp(published, tz=timezone.utc))
            published_at = timestamp.isoformat()
        except (ValueError, TypeError, OverflowError, OSError):
            published_at = None
        result.append({"title": title.strip(), "link": link, "publisher": publisher or "", "publishedAt": published_at})
        if len(result) == 10:
            break
    return result


def ticker_news(ticker_symbol):
    results = yf.Search(ticker_symbol, max_results=0, news_count=20, lists_count=0, timeout=8).news
    return normalize_news(item for item in results if isinstance(item, dict)
                          and item.get("type") != "VIDEO"
                          and ticker_symbol in (item.get("relatedTickers") or [ticker_symbol]))


def stock_analyst(ticker, info):
    labels = {"strongBuy": "Strong buy", "buy": "Buy", "hold": "Hold", "sell": "Sell", "strongSell": "Strong sell"}
    recommendation = str(info.get("recommendationKey", "")).lower().replace("_", "")
    sentiment = next((label for key, label in labels.items() if key.lower() == recommendation), None)
    ratings = {}
    try:
        recommendations = ticker.recommendations_summary
        if recommendations is not None and "period" in recommendations:
            current = recommendations[recommendations["period"].eq("0m")]
            if not current.empty:
                row = current.iloc[0]
                ratings = {label: max(0, int(number(row.get(key), 0))) for key, label in labels.items()}
    except Exception:
        pass
    total = sum(ratings.values())
    if not sentiment and total:
        score = sum(index * count for index, count in enumerate(ratings.values())) / total
        sentiment = list(labels.values())[int(score + .5)]

    target = {key: number(info.get(f"target{key.title()}Price")) for key in ("mean", "low", "high")}
    if any(value is None or value <= 0 for value in target.values()):
        try:
            targets = ticker.get_analyst_price_targets() or {}
            target = {key: value if value is not None and value > 0 else number(targets.get(key))
                      for key, value in target.items()}
        except Exception:
            pass
    target = {key: value if value is not None and value > 0 else None for key, value in target.items()}
    if not (sentiment or total or any(value is not None for value in target.values())):
        return None
    return {"sentiment": sentiment, "ratings": ratings if total else {}, "target": target,
            "currency": info.get("currency") or "USD"}


def holding_detail(symbol, asset_type):
    ticker_symbol = f"{symbol}-USD" if asset_type == "crypto" else symbol.replace(".", "-")
    def load():
        ticker = yf.Ticker(ticker_symbol)
        warnings = []
        def company_and_analyst():
            try:
                info = ticker.info or {}
            except Exception:
                info = {}
            company = info.get("longName") or info.get("shortName") or symbol
            return company, stock_analyst(ticker, info) if asset_type == "stock" else None

        with ThreadPoolExecutor(max_workers=3) as pool:
            history_job = pool.submit(ticker.history, period="max", auto_adjust=True, timeout=15)
            news_job = pool.submit(ticker_news, ticker_symbol)
            company_job = pool.submit(company_and_analyst)
            try:
                history = daily_history(history_job.result())
                prices = [{"date": day, "close": close} for day, value in history["Close"].items()
                          if (close := number(value, 0)) > 0]
            except Exception:
                prices = []
                warnings.append("Price history is unavailable.")
            try:
                news = news_job.result()
            except Exception:
                news = []
                warnings.append("Recent news is unavailable.")
            company, analyst = company_job.result()
        return {"symbol": symbol, "prices": prices, "news": news, "analyst": analyst,
                "source": "Yahoo Finance adjusted market data (splits and distributions)",
                "company": company, "warnings": warnings}
    return cached(("detail", ticker_symbol, asset_type), load, 300)
