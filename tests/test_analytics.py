from datetime import date
import math
import unittest

import pandas as pd

from analytics import biweekly_voo_values, calculate_portfolio, comparison_returns, daily_history, holding_duration, monthly_contributions, money_weighted_return, number


TODAY = date(2026, 1, 1)


def holding(symbol="OPEN", quantity=10, basis=100, value=150, kind="stock"):
    return {"symbol": symbol, "name": symbol, "quantity": quantity, "costBasis": basis,
            "avgCost": basis / quantity if basis is not None else None,
            "currentPrice": value / quantity if value is not None else None,
            "currentValue": value, "assetType": kind, "sector": "Test", "isEtf": False}


def trade(symbol, day, amount, quantity, kind=None, asset_type="stock"):
    return {"symbol": symbol, "date": day, "amount": amount, "quantity": quantity,
            "kind": kind or ("buy" if amount < 0 else "sell"), "assetType": asset_type}


def history(prices=None):
    return pd.DataFrame({"Close": prices or [10, 10, 10]},
                        index=pd.to_datetime(["2025-01-01", "2025-06-01", "2026-01-01"]))


class AccountingTests(unittest.TestCase):
    def test_comparison_xirr_uses_the_opening_mark_and_only_subsequent_flows(self):
        end = date(2026, 1, 31)
        rows = [
            {"date": "2025-10-31", "portfolio": 80, "sp500": 80},
            {"date": "2025-12-31", "portfolio": 100, "sp500": 100},
            {"date": end.isoformat(), "portfolio": 124, "sp500": 121},
        ]
        flows = [{"date": "2025-12-31", "amount": -20}, {"date": "2026-01-15", "amount": -20}]
        rates = comparison_returns(rows, flows, end, .18, .15)
        expected = [{"date": "2025-12-31", "amount": -100}, flows[1]]
        self.assertAlmostEqual(rates["1M"]["portfolioXirr"], money_weighted_return(expected, 124, end))
        self.assertAlmostEqual(rates["1M"]["vooXirr"], money_weighted_return(expected, 121, end))
        self.assertEqual(rates["All"], {"portfolioXirr": .18, "vooXirr": .15})
        self.assertEqual(rates["1Y"], rates["All"])
        self.assertNotEqual(rates["1M"], rates["All"])

    def test_biweekly_voo_uses_equal_net_contributions_excluding_todays_trades(self):
        trades = [
            trade("OPEN", "2026-01-03", -650, 6),
            trade("OPEN", "2026-01-22", 50, -1),
            trade("OPEN", "2026-01-31", -999, 9),
        ]
        prices = daily_history(pd.DataFrame({"Close": [100, 200, 300, 360]},
                                            index=["2026-01-05", "2026-01-20", "2026-01-30", "2026-02-02"]))
        values = biweekly_voo_values(trades, prices, date(2026, 1, 31))
        self.assertEqual(values["2026-01-05"], 200)
        self.assertEqual(values["2026-01-20"], 600)
        self.assertEqual(values["2026-01-31"], 1100)
    def test_monthly_contribution_keeps_closed_positions_crypto_and_drip_basis(self):
        holdings = [holding("FUND", 11, 110, 143, "etf"), holding("BTC", 0.0000005, 25, 35, "crypto")]
        events = [
            trade("FUND", "2025-01-02", -100, 10),
            trade("CLOSED", "2025-01-05", -30, 3),
            trade("BTC", "2025-01-06", -25, 0.0000005, asset_type="crypto"),
            trade("FUND", "2025-01-22", 10, 0, "dividend") | {"reinvested": True},
            trade("FUND", "2025-01-22", -10, 1),
            trade("CLOSED", "2025-02-03", 42, -3),
            trade("FUND", "2025-02-10", 2, 0, "dividend"),
        ]
        histories = {(kind, symbol): daily_history(pd.DataFrame({"Close": [price]}, index=["2025-01-31"]))
                     for kind, symbol, price in [("stock", "FUND", 12), ("stock", "CLOSED", 13), ("crypto", "BTC", 60000000)]}
        report = monthly_contributions(holdings, events, histories, date(2025, 2, 15))
        self.assertEqual([{(row["assetType"], row["symbol"]): row["value"] for row in month["assets"]} for month in report], [
            {("etf", "FUND"): 22, ("stock", "CLOSED"): 9, ("crypto", "BTC"): 5},
            {("etf", "FUND"): 13, ("stock", "CLOSED"): 3, ("crypto", "BTC"): 5},
        ])

    def test_monthly_contribution_requires_a_price_on_both_sides_of_the_range(self):
        positions = [holding("MISSING", 1, 10, 15)]
        events = [trade("MISSING", "2025-01-10", -10, 1)]
        report = monthly_contributions(positions, events, {}, date(2025, 2, 15))
        self.assertEqual([month["assets"][0]["value"] for month in report], [None, None])

    def calculate(self, holdings, events, histories=None, **kwargs):
        keys = {(e["assetType"], e["symbol"]) for e in events if e["kind"] != "dividend"}
        if histories is None:
            histories = {key: history() for key in keys}
        return calculate_portfolio(holdings, events, histories, history([100, 110, 120]), TODAY, **kwargs)

    def test_largest_stock_sector_excludes_fund_exposure_but_uses_total_invested_value(self):
        positions = [dict(holding("A", value=160), sector="Technology"),
                     dict(holding("B", value=140), sector="Technology"),
                     dict(holding("C", value=200), sector="Healthcare"),
                     dict(holding("D", value=400), sector="Uncategorized"),
                     dict(holding("FUND", value=600, kind="etf"), sector="Healthcare"),
                     dict(holding("COIN", value=500, kind="crypto"), sector="Crypto")]
        result = self.calculate(positions, [])
        self.assertEqual(result["insights"]["largestStockSector"], {"name": "Technology", "weight": 15.0})
        partial = self.calculate(positions, [], valuation_complete=False)
        self.assertIsNone(partial["insights"]["largestStockSector"])

    def test_closed_positions_contribute_to_total_and_realized_profit(self):
        events = [trade("OPEN", "2025-01-01", -100, 10),
                  trade("CLOSED", "2025-01-01", -100, 10),
                  trade("CLOSED", "2025-06-01", 200, -10)]
        data = self.calculate([holding()], events)
        self.assertEqual(data["totalInvestment"], 0)
        self.assertEqual(data["totalProfitLoss"], 150)
        self.assertEqual(data["insights"]["realizedGains"], 100)
        self.assertEqual(data["insights"]["unrealizedGains"], 50)
        self.assertIsNotNone(data["overallXirr"])

    def test_fully_liquidated_portfolio_retains_realized_profit(self):
        data = self.calculate([], [trade("OLD", "2025-01-01", -100, 10),
                                   trade("OLD", "2025-06-01", 150, -10)])
        self.assertEqual(data["totalCurrentValue"], 0)
        self.assertEqual(data["totalProfitLoss"], 50)
        self.assertEqual(data["insights"]["realizedGains"], 50)
        self.assertEqual(data["historicalData"][-1]["portfolio"], 0)

    def test_partial_sale_uses_remaining_basis_for_unrealized_return(self):
        data = self.calculate([holding(quantity=5, basis=50, value=75)],
                              [trade("OPEN", "2025-01-01", -100, 10),
                               trade("OPEN", "2025-06-01", 75, -5)])
        stock = data["stocks"][0]
        self.assertEqual(stock["investment"], 50)
        self.assertEqual(stock["netInvested"], 25)
        self.assertEqual(stock["profitLoss"], 25)
        self.assertEqual(stock["returnPct"], 50)
        self.assertEqual(stock["totalReturnPct"], 50)
        self.assertEqual(data["totalProfitLoss"], 50)
        self.assertEqual(data["insights"]["realizedGains"], 25)

    def test_paid_dividends_contribute_to_xirr_and_total_profit(self):
        dividend = trade("OPEN", "2026-01-01", 10, 0, "dividend")
        dividend.update(reinvested=False, reinvestmentKnown=True)
        events = [trade("OPEN", "2025-01-01", -100, 10), dividend]
        data = self.calculate([holding(value=100)], events)
        self.assertAlmostEqual(data["overallXirr"], .1, places=5)
        self.assertAlmostEqual(data["stocks"][0]["xirr"], .1, places=5)
        self.assertEqual(data["totalProfitLoss"], 10)
        self.assertEqual(data["insights"]["realizedGains"], 0)
        self.assertEqual(data["dividends"]["received"], 10)
        self.assertEqual(data["dividends"]["paid"], 10)
        self.assertEqual(data["dividends"]["reinvested"], 0)

    def test_unknown_dividend_reinvestment_only_hides_affected_returns(self):
        events = [trade("OPEN", "2025-01-01", -100, 10),
                  trade("OTHER", "2025-01-01", -100, 10),
                  trade("OPEN", "2026-01-01", 10, 0, "dividend")]
        data = self.calculate([holding(value=100), holding("OTHER", value=120)], events)
        self.assertEqual(data["totalInvestment"], 200)
        self.assertIsNone(data["totalProfitLoss"])
        self.assertIsNone(data["overallXirr"])
        self.assertIsNone(data["sp500"])
        self.assertIsNone(data["stocks"][0]["xirr"])
        self.assertAlmostEqual(data["stocks"][1]["xirr"], .2)
        self.assertIsNone(data["dividends"]["paid"])
        self.assertIsNone(data["dividends"]["reinvested"])
        self.assertTrue(any("did not confirm which dividends were reinvested" in warning for warning in data["warnings"]))

    def test_each_asset_uses_its_own_dated_cash_flows(self):
        dividend = trade("OPEN", "2025-09-01", 5, 0, "dividend")
        dividend.update(reinvested=False, reinvestmentKnown=True)
        events = [trade("OPEN", "2025-01-01", -100, 10),
                  trade("OPEN", "2025-03-01", -50, 5),
                  trade("OPEN", "2025-06-01", 40, -4),
                  dividend,
                  trade("FUND", "2025-07-02", -200, 1),
                  trade("BTC", "2025-12-31", -100, 1, asset_type="crypto")]
        stock_rate = .13
        stock_terminal = -sum(e["amount"] * (1 + stock_rate) ** ((TODAY - date.fromisoformat(e["date"])).days / 365)
                              for e in events[:4])
        data = self.calculate([holding(quantity=11, value=stock_terminal),
                               holding("FUND", 1, 200, 220, "etf"),
                               holding("BTC", 1, 100, 101, "crypto")], events)
        stock, etf, crypto = data["stocks"]
        self.assertAlmostEqual(stock["xirr"], stock_rate, places=8)
        self.assertAlmostEqual(etf["xirr"], 1.1 ** (365 / 183) - 1, places=8)
        self.assertAlmostEqual(crypto["xirr"], 1.01 ** 365 - 1, places=7)
        growth = 1 + data["overallXirr"]
        ending_balance = sum(e["amount"] * growth ** ((TODAY - date.fromisoformat(e["date"])).days / 365)
                             for e in events) + data["totalCurrentValue"]
        self.assertAlmostEqual(ending_balance, 0, places=5)

    def test_bad_crypto_history_does_not_hide_valid_stock_returns_or_paid_dividends(self):
        dividend = trade("OPEN", "2026-01-01", 10, 0, "dividend")
        dividend.update(reinvested=False, reinvestmentKnown=True)
        events = [trade("OPEN", "2025-01-01", -100, 10), dividend]
        data = self.calculate([holding(value=100)], events, ledger_complete=False,
                              income_complete=True, trade_completeness={"stock": True, "crypto": False})
        self.assertFalse(data["tradeHistoryComplete"])
        self.assertIsNone(data["overallXirr"])
        self.assertAlmostEqual(data["stocks"][0]["xirr"], .1, places=5)
        self.assertEqual(data["dividends"]["received"], 10)
        self.assertNotEqual(data["stocks"][0]["timeHeld"], "Unavailable")

    def test_bad_dividend_history_does_not_hide_crypto_returns_or_stock_holding_age(self):
        events = [trade("OPEN", "2025-01-01", -100, 10),
                  trade("BTC", "2025-01-01", -100, 1, asset_type="crypto")]
        data = self.calculate([holding(value=110), holding("BTC", 1, 100, 110, "crypto")], events,
                              ledger_complete=False, income_complete=False,
                              trade_completeness={"stock": True, "crypto": True})
        self.assertTrue(data["tradeHistoryComplete"])
        self.assertIsNone(data["stocks"][0]["xirr"])
        self.assertIsNotNone(data["stocks"][1]["xirr"])
        self.assertNotEqual(data["stocks"][0]["timeHeld"], "Unavailable")
        self.assertIsNone(data["dividends"]["paid"])

    def test_reinvested_dividend_counts_as_investment_without_increasing_profit(self):
        dividend = trade("OPEN", "2025-06-01", 10, 0, "dividend")
        dividend.update(reinvested=True, reinvestmentKnown=True)
        data = self.calculate([holding(quantity=11, basis=110, value=110)],
                              [trade("OPEN", "2025-01-01", -100, 10), dividend,
                               trade("OPEN", "2025-06-01", -10, 1)])
        self.assertEqual(data["totalInvestment"], 110)
        self.assertEqual(data["totalProfitLoss"], 0)
        self.assertAlmostEqual(data["overallXirr"], 0)
        self.assertAlmostEqual(data["stocks"][0]["xirr"], 0)
        self.assertEqual(data["dividends"]["reinvested"], 10)
        self.assertEqual(data["dividends"]["paid"], 0)
        self.assertEqual(data["dividends"]["received"], 10)

    def test_only_cash_dividends_count_as_proceeds_for_profit_and_xirr(self):
        reinvested = trade("OPEN", "2025-06-01", 10, 0, "dividend")
        reinvested.update(reinvested=True, reinvestmentKnown=True)
        cash = trade("OPEN", "2026-01-01", 1.81, 0, "dividend")
        cash.update(reinvested=False, reinvestmentKnown=True)
        data = self.calculate([holding(quantity=11, basis=110, value=110)],
                              [trade("OPEN", "2025-01-01", -100, 10), reinvested,
                               trade("OPEN", "2025-06-01", -10, 1), cash])
        self.assertEqual(data["dividends"]["reinvested"], 10)
        self.assertEqual(data["dividends"]["paid"], 1.81)
        self.assertEqual(data["dividends"]["received"], 11.81)
        self.assertAlmostEqual(data["totalProfitLoss"], 1.81)
        self.assertAlmostEqual(data["stocks"][0]["totalReturnPct"], 1.81 / 110 * 100)
        for rate in (data["overallXirr"], data["stocks"][0]["xirr"]):
            self.assertAlmostEqual(100 * (1 + rate) + 10 * (1 + rate) ** (214 / 365), 111.81, places=6)
        self.assertAlmostEqual(data["sp500"]["currentValue"], 120 * (1 + 10 / 110) - 1.81)

    def test_missing_quote_does_not_create_a_total_loss(self):
        data = self.calculate([holding(value=None)], [trade("OPEN", "2025-01-01", -100, 10)])
        for field in ["totalCurrentValue", "totalProfitLoss", "overallXirr"]:
            self.assertIsNone(data[field])
        self.assertIsNone(data["stocks"][0]["profitLoss"])
        self.assertFalse(data["valuationComplete"])

    def test_missing_cost_basis_does_not_create_unrealized_gains(self):
        data = self.calculate([holding(basis=None)], [trade("OPEN", "2025-01-01", -100, 10)])
        self.assertIsNone(data["stocks"][0]["profitLoss"])
        self.assertIsNone(data["insights"]["unrealizedGains"])
        self.assertEqual(data["totalProfitLoss"], 50)

    def test_missing_order_history_leaves_returns_unavailable(self):
        data = self.calculate([holding()], [])
        self.assertFalse(data["accountingComplete"])
        self.assertIsNone(data["totalProfitLoss"])
        self.assertIsNone(data["overallXirr"])
        self.assertEqual(data["stocks"][0]["costBasis"], 100)

    def test_same_ticker_crypto_and_stock_are_separate(self):
        data = self.calculate([holding("SAME"), holding("SAME", 1, 200, 300, "crypto")],
                              [trade("SAME", "2025-01-01", -100, 10),
                               trade("SAME", "2025-01-01", -200, 1, asset_type="crypto")])
        self.assertTrue(data["accountingComplete"])
        self.assertEqual(data["totalProfitLoss"], 150)

    def test_nonfinite_values_and_uncomputable_xirr_are_unavailable(self):
        for value in ["nan", "inf", "-inf", None, "bad"]:
            self.assertIsNone(number(value))
        self.assertIsNone(money_weighted_return([], 100, TODAY))
        self.assertIsNone(money_weighted_return([trade("A", str(TODAY), -100, 1)], 100, TODAY))
        self.assertIsNone(money_weighted_return([trade("A", "2025-01-01", -100, 1)], math.nan, TODAY))

    def test_short_holding_loss_remains_solvable_with_multiple_purchases(self):
        events = [trade("A", "2025-12-30", -100, 1), trade("A", "2025-12-31", -100, 1)]
        # With evenly spaced days the equation is 175*q^2 - 100*q - 100 = 0.
        daily_discount = (100 + math.sqrt(80000)) / 350
        expected = math.expm1(-365 * math.log(daily_discount))
        self.assertEqual(money_weighted_return(events, 175, TODAY), expected)

    def test_reentry_resets_current_holding_period(self):
        data = self.calculate([holding()], [trade("OPEN", "2025-01-01", -100, 10),
                                           trade("OPEN", "2025-06-01", 120, -10),
                                           trade("OPEN", "2025-12-31", -100, 10)])
        self.assertEqual(data["stocks"][0]["timeHeld"], "1 day")

    def test_holding_duration_uses_calendar_months_and_leap_days(self):
        self.assertEqual(holding_duration(date(2023, 10, 29), TODAY), "2 years, 2 months, 3 days")
        self.assertEqual(holding_duration(date(2024, 1, 31), date(2024, 2, 29)), "1 month")
        self.assertEqual(holding_duration(date(2024, 2, 29), date(2025, 2, 28)), "1 year")
        self.assertEqual(holding_duration(TODAY, TODAY), "0 days")

    def test_stock_reward_reconciles_history_without_becoming_a_realized_loss(self):
        award = {"symbol": "OPEN", "assetType": "stock", "kind": "grant", "quantity": .5,
                 "date": "2025-01-01", "amount": 0, "rewardValue": 5}
        data = self.calculate([holding(quantity=10.5, basis=100, value=157.5)],
                              [award, trade("OPEN", "2025-06-01", -100, 10)])
        self.assertTrue(data["accountingComplete"])
        self.assertEqual(data["totalInvestment"], 100)
        self.assertEqual(data["totalProfitLoss"], 57.5)
        self.assertEqual(data["insights"]["stockRewards"], 5)
        self.assertEqual(data["insights"]["realizedGains"], 0)
        self.assertEqual(data["insights"]["unrealizedGains"], 57.5)
        self.assertEqual(data["historicalData"][0]["portfolio"], 5)
        self.assertEqual(data["historicalData"][0]["netInvestment"], 0)

    def test_realized_profit_rounds_floating_point_residue_to_positive_zero(self):
        data = self.calculate([holding(basis=99.99999999999)], [trade("OPEN", "2025-01-01", -100, 10)])
        self.assertEqual(data["insights"]["realizedGains"], 0.0)
        self.assertEqual(str(data["insights"]["realizedGains"]), "0.0")


class HistoricalTests(unittest.TestCase):
    calculate = AccountingTests.calculate

    def test_weekly_and_monthly_moves_use_real_prior_closes(self):
        days = pd.date_range("2025-11-01", TODAY)
        frame = pd.DataFrame({"Close": range(100, 100 + len(days))}, index=days)
        data = self.calculate([holding(value=2000)], [trade("OPEN", "2025-11-01", -1000, 10)],
                              {("stock", "OPEN"): frame})
        self.assertAlmostEqual(data["stocks"][0]["week"], (200 / float(frame.loc["2025-12-25", "Close"]) - 1) * 100)
        self.assertAlmostEqual(data["stocks"][0]["month"], (200 / float(frame.loc["2025-12-02", "Close"]) - 1) * 100)

    def test_current_day_contribution_without_a_new_benchmark_candle_stays_cash(self):
        benchmark = pd.DataFrame({"Close": [100, 110]}, index=pd.to_datetime(["2025-01-01", "2025-12-31"]))
        events = [trade("OPEN", "2025-01-01", -100, 10), trade("OPEN", str(TODAY), -100, 10)]
        data = calculate_portfolio([holding(quantity=20, basis=200, value=250)], events,
                                   {("stock", "OPEN"): history()}, benchmark, TODAY)
        self.assertEqual(data["sp500"]["currentValue"], 210)
        self.assertEqual(data["historicalData"][-1]["sp500"], 210)
    def test_history_uses_positions_and_prices_not_contributions(self):
        data = self.calculate([holding(value=150)], [trade("OPEN", "2025-01-01", -100, 10)],
                              {("stock", "OPEN"): history([10, 12, 15])})
        rows = {row["date"]: row for row in data["historicalData"]}
        self.assertEqual(rows["2025-06-01"]["portfolio"], 120)
        self.assertEqual(rows["2025-06-01"]["netInvestment"], 100)
        self.assertEqual(rows["2025-12-31"]["portfolio"], 120)
        self.assertEqual(rows[str(TODAY)]["portfolio"], 150)

    def test_historical_alignment_leaves_days_before_first_market_price_unknown(self):
        frame = pd.DataFrame({"Close": [12, 14]}, index=pd.to_datetime(["2025-06-02", "2025-06-04"]))
        data = self.calculate([holding(value=150)], [trade("OPEN", "2025-06-01", -100, 10)],
                              {("stock", "OPEN"): frame})
        rows = {row["date"]: row["portfolio"] for row in data["historicalData"]}
        self.assertIsNone(rows["2025-06-01"])
        self.assertEqual(rows["2025-06-03"], 120)
        self.assertEqual(rows["2025-06-04"], 140)
        self.assertEqual(rows[str(TODAY)], 150)

    def test_history_preserves_the_exchange_day_for_timezone_aware_prices(self):
        index = pd.DatetimeIndex(["2025-06-01 23:45", "2025-06-02 00:15"],
                                 tz="America/New_York")
        frame = pd.DataFrame({"Close": [10, 12]}, index=index)
        self.assertEqual(daily_history(frame)["Close"].to_dict(),
                         {"2025-06-01": 10, "2025-06-02": 12})

    def test_today_trade_is_in_benchmark_and_has_its_own_date(self):
        data = self.calculate([holding(quantity=20, basis=200, value=250)],
                              [trade("OPEN", "2025-01-01", -100, 10), trade("OPEN", str(TODAY), -100, 10)])
        self.assertEqual(data["historicalData"][-1]["date"], str(TODAY))
        self.assertEqual(data["historicalData"][-1]["sp500"], data["sp500"]["currentValue"])
        self.assertEqual(data["historicalData"][-1]["portfolio"], 250)
        self.assertEqual(data["historicalData"][-2]["portfolio"], 100)

    def test_split_adjusted_prices_and_trade_quantities_reconcile(self):
        frame = history([5, 6, 7.5])
        frame["Stock Splits"] = [0, 2, 0]
        data = self.calculate([holding(quantity=20, basis=100, value=150)],
                              [trade("OPEN", "2025-01-01", -100, 10)], {("stock", "OPEN"): frame})
        self.assertTrue(data["accountingComplete"])
        rows = {r["date"]: r for r in data["historicalData"]}
        self.assertEqual(rows["2025-01-01"]["portfolio"], 100)
        self.assertEqual(rows["2025-06-01"]["portfolio"], 120)

    def test_transfer_or_unreconciled_position_never_gets_fabricated_history(self):
        data = self.calculate([holding(quantity=11)], [trade("OPEN", "2025-01-01", -100, 10)])
        self.assertFalse(data["accountingComplete"])
        self.assertTrue(all(row["portfolio"] is None for row in data["historicalData"]))
        self.assertIsNone(data["totalProfitLoss"])
        self.assertTrue(data["warnings"])

    def test_unfundable_benchmark_withdrawal_is_not_capped(self):
        data = self.calculate([], [trade("OPEN", "2025-01-01", -100, 10),
                                   trade("OPEN", "2025-06-01", 1000, -10)])
        self.assertIsNone(data["sp500"])
        self.assertIsNone(data["insights"]["alpha"])
        self.assertTrue(any("exhaust" in w for w in data["warnings"]))

    def test_weekend_contribution_is_pending_cash_until_market_opens(self):
        days = pd.to_datetime(["2025-12-26", "2025-12-29", "2026-01-01"])
        benchmark = pd.DataFrame({"Close": [100, 110, 120]}, index=days)
        data = calculate_portfolio([holding("BTC", 1, 100, 120, "crypto")],
                                   [trade("BTC", "2025-12-27", -100, 1, asset_type="crypto")],
                                   {("crypto", "BTC"): pd.DataFrame({"Close": [100, 120]},
                                    index=pd.to_datetime(["2025-12-27", "2026-01-01"]))}, benchmark, TODAY)
        rows = {r["date"]: r for r in data["historicalData"]}
        self.assertEqual(rows["2025-12-27"]["sp500"], 100)
        self.assertEqual(rows["2025-12-29"]["sp500"], 100)
        self.assertAlmostEqual(data["sp500"]["currentValue"], 100 / 110 * 120)


if __name__ == "__main__":
    unittest.main()
