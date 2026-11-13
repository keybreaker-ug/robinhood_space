"""Public market snapshots for the local research workspace."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

from analytics import daily_history, number
from broker_data import cached, stock_analyst, ticker_news


def yahoo_symbol(symbol, kind):
    if kind == "crypto":
        return symbol if symbol.endswith("-USD") else f"{symbol}-USD"
    return symbol.replace(".", "-")


def attempt(loader, default):
    try:
        return loader()
    except Exception:
        return default


def price_history(symbol):
    return cached(("research-prices", symbol), lambda: daily_history(
        yf.Ticker(symbol).history(period="1y", auto_adjust=True, timeout=8)), 300)


def benchmark_history_snapshot(symbol):
    history = price_history(symbol)
    return [{"date": day, "close": number(value)} for day, value in history["Close"].items()]


def market_date(value):
    try:
        instant = pd.Timestamp(value, unit="s", tz="UTC") if isinstance(value, (int, float)) else pd.Timestamp(value)
        return instant.date().isoformat() if pd.notna(instant) else None
    except (TypeError, ValueError, OverflowError):
        return None


def relative_move(prices, benchmark):
    paired = pd.concat([prices.rename("asset"), benchmark.rename("benchmark")], axis=1, join="inner").dropna()
    if len(paired) < 2:
        return None
    end = pd.Timestamp(paired.index[-1])
    target = end - pd.DateOffset(months=3)
    start = paired.index.searchsorted(target.date().isoformat(), side="right") - 1
    if start < 0 or (target - pd.Timestamp(paired.index[start])).days > 7:
        return None
    change = (paired.iloc[-1] / paired.iloc[start] - 1) * 100
    return number(change["asset"] - change["benchmark"])


def market_snapshot(symbol, kind):
    ticker_symbol = yahoo_symbol(symbol, kind)
    def load():
        ticker = yf.Ticker(ticker_symbol)
        info = attempt(lambda: ticker.info, {}) or {}
        history = attempt(lambda: price_history(ticker_symbol), daily_history(None))
        prices = history["Close"]
        market = "BTC-USD" if kind == "crypto" else "VOO"
        reference = attempt(lambda: price_history(market), daily_history(None))
        latest = number(prices.iloc[-1]) if len(prices) else None
        snapshot = {
            "symbol": symbol, "assetType": kind, "name": info.get("longName") or info.get("shortName") or symbol,
            "sector": info.get("sector"), "industry": info.get("industry"),
            "close": latest, "asOf": prices.index[-1] if len(prices) else None,
            "price": number(info.get("regularMarketPrice")) or latest,
            "quoteDate": market_date(info.get("regularMarketTime")),
            "sma50": number(prices.tail(50).mean()) if len(prices) >= 50 else None,
            "sma200": number(prices.tail(200).mean()) if len(prices) >= 200 else None,
            "relative3m": relative_move(prices, reference["Close"]), "benchmark": "BTC" if kind == "crypto" else "VOO",
        }
        if kind == "stock":
            revisions = attempt(lambda: ticker.eps_revisions, None)
            row = revisions.loc["0q"] if revisions is not None and "0q" in revisions.index else {}
            calendar = attempt(lambda: ticker.calendar, {}) or {}
            dates = calendar.get("Earnings Date") or []
            if not isinstance(dates, (list, tuple)):
                dates = [dates]
            today = datetime.now(timezone.utc).date().isoformat()
            earnings = sorted(day for value in dates if (day := market_date(value)) and day >= today)
            estimate = number(info.get("forwardPE"))
            snapshot.update(forwardPE=estimate if estimate and estimate > 0 else None,
                            growth=number(info.get("earningsGrowth")), margin=number(info.get("operatingMargins")),
                            freeCashFlow=number(info.get("freeCashflow")), revisionsUp=number(row.get("upLast30days")),
                            revisionsDown=number(row.get("downLast30days")), earnings=earnings[0] if earnings else None)
        if kind == "etf":
            snapshot.update(expenseRatio=number(info.get("netExpenseRatio")), category=info.get("category"))
        if kind == "crypto" and len(prices):
            cutoff = (pd.Timestamp(prices.index[-1]) - pd.Timedelta(days=90)).date().isoformat()
            recent = prices.loc[cutoff:]
            snapshot["drawdown90"] = number((recent / recent.cummax() - 1).min() * 100) if len(recent) > 1 else None
            volume = pd.to_numeric(history.get("Volume", pd.Series(dtype=float)), errors="coerce").tail(30)
            snapshot["turnover30"] = number((prices.tail(30) * volume).mean()) if len(volume) == 30 and volume.gt(0).all() else None
        if snapshot["price"] is None:
            snapshot["unavailable"] = True
        return snapshot
    return cached(("research-market", kind, ticker_symbol), load, 300)


def fund_snapshot(symbol):
    def load():
        ticker = yf.Ticker(yahoo_symbol(symbol, "etf"))
        funds = ticker.funds_data
        positions = attempt(lambda: funds.top_holdings, pd.DataFrame())
        sectors = attempt(lambda: funds.sector_weightings, {}) or {}
        allocation = attempt(lambda: funds.asset_classes, {}) or {}
        stock_weight = number(allocation.get("stockPosition"))
        info = attempt(lambda: ticker.info, {}) or {}
        holdings = []
        if positions is not None:
            for ticker_symbol, row in positions.iterrows():
                weight = number(row.get("Holding Percent"))
                if isinstance(ticker_symbol, str) and ticker_symbol.strip() and weight is not None and 0 < weight <= 1:
                    holdings.append({"symbol": ticker_symbol.upper().strip(), "name": str(row.get("Name") or ticker_symbol), "weight": weight})
        return {"symbol": symbol, "assetType": "etf", "holdings": holdings,
                "sectors": {key: weight for key, value in sectors.items() if (weight := number(value)) is not None and 0 < weight <= 1},
                "stockWeight": min(1, max(0, stock_weight)) if stock_weight is not None else None,
                "reportedAsOf": market_date(info.get("holdingsAsOfDate")),
                "retrievedOn": datetime.now(timezone.utc).date().isoformat(), "source": "Yahoo Finance"}
    return cached(("research-fund", symbol), load, 3600)


def quote_snapshot(symbol, kind):
    ticker_symbol = yahoo_symbol(symbol, kind)
    def load():
        info = yf.Ticker(ticker_symbol).info
        return {"symbol": symbol, "assetType": kind, "price": number(info.get("regularMarketPrice")),
                "quoteDate": market_date(info.get("regularMarketTime"))}
    return cached(("research-alert", ticker_symbol), load, 300)


def research_snapshots(items, mode):
    def snapshot(item):
        symbol, kind = item
        try:
            if mode == "funds":
                return fund_snapshot(symbol)
            if mode == "quotes":
                return quote_snapshot(symbol, kind)
            return market_snapshot(symbol, kind)
        except Exception:
            return {"symbol": symbol, "assetType": kind, "unavailable": True}

    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(snapshot, items))


ATLAS_MARKETS = {"S&P 500": "^GSPC", "Nasdaq-100": "^NDX", "Dow Jones": "^DJI", "Bitcoin": "BTC-USD"}


def atlas_benchmarks():
    def load(item):
        label, symbol = item
        history = attempt(lambda: _atlas_chart(symbol, "5y"), [])
        return label, {"points": history}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(pool.map(load, ATLAS_MARKETS.items()))


def atlas_sp500_history():
    return _atlas_chart(ATLAS_MARKETS["S&P 500"], "max")


def _atlas_chart(symbol, period):
    def load():
        history = daily_history(yf.Ticker(symbol).history(period=period, auto_adjust=False, timeout=10))
        if history.empty:
            raise ValueError(f"No price history returned for {symbol}")
        return [[day, number(row["Close"]), number(row.get("Adj Close"), number(row["Close"])),
                 number(row.get("Volume"))] for day, row in history.iterrows()]
    return cached(("atlas-chart", symbol, period), load, 900)


ATLAS_STATEMENTS = {
    "income_stmt": {"Revenue": "Total Revenue", "Gross profit": "Gross Profit", "Operating income": "Operating Income",
                    "EBITDA": "EBITDA", "Interest expense": "Interest Expense", "Net income": "Net Income", "Diluted EPS": "Diluted EPS"},
    "balance_sheet": {"Total assets": "Total Assets", "Current assets": "Current Assets",
                      "Current liabilities": "Current Liabilities", "Cash & short-term investments": "Cash Cash Equivalents And Short Term Investments",
                      "Total debt": "Total Debt", "Book equity": "Stockholders Equity"},
    "cashflow": {"Operating cash flow": "Operating Cash Flow", "Capital expenditure": "Capital Expenditure", "Free cash flow": "Free Cash Flow"},
}


def atlas_security(symbol, kind, view):
    ticker_symbol = yahoo_symbol(symbol, kind)
    if view == "chart":
        return {"points": attempt(lambda: _atlas_chart(ticker_symbol, "max"), [])}
    if view == "financials":
        def load():
            ticker = yf.Ticker(ticker_symbol)
            metrics = {}
            for statement, mapping in ATLAS_STATEMENTS.items():
                frame = attempt(lambda: getattr(ticker, statement), pd.DataFrame())
                for label, field in mapping.items():
                    if field in frame.index:
                        metrics[label] = {date.date().isoformat(): number(value) for date, value in frame.loc[field].items()}
            return {"metrics": metrics}
        return cached(("atlas-statements", ticker_symbol), load, 3600)
    def load_analyst():
        ticker = yf.Ticker(ticker_symbol)
        analyst = stock_analyst(ticker, attempt(lambda: ticker.info, {}) or {})
        if analyst is None:
            raise LookupError("No analyst data returned")
        return analyst

    with ThreadPoolExecutor(max_workers=2) as pool:
        stories_job = pool.submit(attempt, lambda: cached(("atlas-news", ticker_symbol),
                                                         lambda: ticker_news(ticker_symbol), 300), None)
        analyst_job = pool.submit(attempt, lambda: cached(("atlas-analyst", ticker_symbol), load_analyst, 300),
                                  None) if kind == "stock" else None
        stories = stories_job.result()
        analyst = analyst_job.result() if analyst_job else None
    return {"stories": [{"title": item["title"], "url": item["link"], "source": item["publisher"],
                         "date": item.get("publishedAt") or "", "tone": "Unclear"} for item in stories or []],
            "analyst": analyst, "pressError": stories is None}
