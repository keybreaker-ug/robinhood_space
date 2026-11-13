"""Map Ravenhood's reconciled Robinhood data to Portfolio Atlas."""
from datetime import datetime, timezone


def snapshot(data):
    day = data["asOf"]
    positions = []
    for row in data["stocks"]:
        kind, symbol = row["assetType"], row["symbol"]
        value, price, previous = row["currentValue"], row["currentPrice"], row.get("previousClose")
        cap = row.get("marketCap")
        cap_band = None if not cap else ("Mega cap" if cap >= 200e9 else "Large cap" if cap >= 10e9
                                         else "Mid cap" if cap >= 2e9 else "Small and micro cap")
        xirr = row.get("xirr")
        positions.append({
            "isin": f"{kind}:{symbol}", "symbol": symbol, "name": row["name"], "account": 1,
            "asset": {"stock": "Equity", "etf": "MF/ETF", "crypto": "Crypto"}[kind],
            "assetType": kind, "qty": row["quantity"], "cur_value": value, "cmp": price,
            "cost_value": row.get("costBasis"), "gain": row.get("profitLoss"),
            "avgBuyPrice": row.get("avgCost"), "totalReturn": row.get("totalReturnPct"),
            "timeHeld": row.get("timeHeld"), "timeHeldDays": row.get("timeHeldDays"),
            "week": row.get("week"), "month": row.get("month"),
            "brokerXirr": 100 * xirr if xirr is not None else None,
            "live": price is not None, "previousClose": previous,
            "day_chg": (price - previous) * row["quantity"] if price is not None and previous else None,
            "navMove": 100 * (price / previous - 1) if price is not None and previous else None,
            "quoteDate": day if price is not None else None, "sector": row.get("sector"),
            "pe": row.get("trailingPE"), "mcap": cap, "mcap_bucket": cap_band,
            "wk52_high": row.get("high52"), "wk52_low": row.get("low52"),
        })
    by_symbol = {row["symbol"]: row for row in positions if row["assetType"] != "crypto"}
    events = []
    for event in data.get("cashFlowTransactions", []):
        kind, symbol = event["assetType"], event["symbol"]
        holding = by_symbol.get(symbol) if kind != "crypto" else None
        if holding:
            kind = holding["assetType"]
        units = abs(event["quantity"]) if event.get("quantity") is not None else None
        amount = abs(event["amount"]) if event.get("amount") is not None else None
        events.append({
            "isin": f"{kind}:{symbol}", "date": event["date"], "kind": event["kind"],
            "label": symbol, "account": 1, "quantity": units, "amount": amount,
            "rate": amount / units if amount is not None and units and event["kind"] in ("buy", "sell") else None,
            "venue": "Robinhood", "source": "Robinhood",
            "detail": "Reinvested" if event.get("reinvested") else None,
        })
    trades = [{"isin": row["isin"], "date": row["date"], "scrip": row["label"],
               "bs": "B" if row["kind"] == "buy" else "S", "qty": row["quantity"],
               "rate": row["rate"], "value": row["amount"]} for row in events if row["kind"] in ("buy", "sell")]
    points = []
    for row in data.get("historicalData", []):
        if row["portfolio"] is None:
            continue
        classes = row.get("assets") or {}
        points.append({"date": row["date"], "value": row["portfolio"], "equity": classes.get("stock"),
                       "funds": classes.get("etf"), "crypto": classes.get("crypto"), "coverage": 100,
                       "latest": row["date"] == day})
    xirr = data.get("overallXirr")
    account = {
        "number": 1, "label": "Robinhood",
        "meta": {"date": day, "live": {"source": "Robinhood · Yahoo Finance",
                 "asof": datetime.now(timezone.utc).isoformat(), "market": "snapshot"}},
        "holdings": positions, "lots": {}, "trades": trades, "recon": {},
        "archive": {"trades": trades, "realized": [], "openLots": [], "reconciliation": []},
        "totals": {"mar_total_mv": None}, "indices": [],
        "reportedValue": data["totalCurrentValue"],
        "portfolioXirr": 100 * xirr if xirr is not None else None,
        "summary": {"netInvested": data.get("totalInvestment"), **(data.get("cashSummary") or {}),
                    "dividends": data.get("dividends") or {}},
        "insights": data.get("insights") or {},
    }
    covered = [min(row["date"] for row in trades), max(row["date"] for row in trades)] if trades and data.get("tradeHistoryComplete") else None
    return {
        "accounts": [account],
        "history": {"asof": day, "custody": points[0]["date"] if points else day,
                    "tradeCoverage": covered, "cashCoverage": None,
                    "scopes": {"all": {"points": points, "statements": [], "events": events}}},
        "comparison": {"points": [dict(row, vooSip=data.get("vooSip", {}).get(row["date"]))
                                  for row in data.get("historicalData", [])],
                       "portfolio": data["totalCurrentValue"], "voo": data.get("sp500"),
                       "returns": data.get("comparisonReturns", {})},
        "warnings": data.get("warnings", []),
    }
