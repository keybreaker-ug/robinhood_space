from datetime import date
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import pandas as pd

import broker_data as b
from tests.test_analytics import history, holding, trade


class BrokerTests(unittest.TestCase):
    def setUp(self):
        b._cache.clear()
        b._instrument_cache.clear()
        referrals = patch.object(b.rh.account, "get_referrals", return_value=[])
        self.referrals_mock = referrals.start()
        self.addCleanup(referrals.stop)
        profile = patch.object(b.rh.profiles, "load_account_profile", return_value=None)
        self.profile_mock = profile.start()
        self.addCleanup(profile.stop)

    def test_risk_comparison_uses_only_shared_portfolio_and_voo_dates(self):
        dates = pd.bdate_range("2025-01-06", periods=41)
        prices = pd.DataFrame({"Close": [100, 105, 102, 107, 104] * 8 + [108]}, index=dates)
        benchmark = prices.copy()
        benchmark.loc[dates[0] - pd.offsets.BDay(), "Close"] = 50
        metrics = b.risk_metrics([holding()], {("stock", "OPEN"): prices}, benchmark)

        for key in ("volatility", "drawdown", "sharpe"):
            self.assertAlmostEqual(metrics[key], metrics["benchmark"][key])
        self.assertAlmostEqual(metrics["beta"], 1)
        self.assertAlmostEqual(metrics["alpha"], 0)
        self.assertIn("40 shared trading days", metrics["note"])

    def test_jensen_alpha_removes_market_sensitivity_before_annualizing(self):
        dates = pd.bdate_range("2025-01-06", periods=41)
        market = pd.Series([0.0] + [.01, -.008, .015, -.004] * 10, index=dates)
        portfolio = .0005 + 1.2 * market
        portfolio.iloc[0] = 0
        prices = pd.DataFrame({"Close": 100 * (1 + portfolio).cumprod()})
        benchmark = pd.DataFrame({"Close": 100 * (1 + market).cumprod()})
        metrics = b.risk_metrics([holding()], {("stock", "OPEN"): prices}, benchmark)

        self.assertAlmostEqual(metrics["beta"], 1.2)
        self.assertAlmostEqual(metrics["alpha"], 12.6)
        self.assertIsNone(b.risk_metrics([holding()], {("stock", "OPEN"): prices}, benchmark.tail(20))["alpha"])

    def test_risk_includes_crypto_weekend_moves_at_their_portfolio_weight(self):
        dates = pd.bdate_range("2025-01-06", periods=41)
        market = pd.Series([0.0] + [.01, -.008, .015, -.004] * 10, index=dates)
        benchmark = pd.DataFrame({"Close": 100 * (1 + market).cumprod()})
        calendar = pd.date_range(dates[0], dates[-1])
        crypto_returns = pd.Series([.10 if day.weekday() == 6 else 0.0 for day in calendar], index=calendar)
        crypto = pd.DataFrame({"Close": 100 * (1 + crypto_returns).cumprod()})
        holdings = [holding(value=600), holding("COIN", value=400, kind="crypto")]
        histories = {("stock", "OPEN"): benchmark, ("crypto", "COIN"): crypto}
        metrics = b.risk_metrics(holdings, histories, benchmark)

        expected = market.iloc[1:] * .6 + [0.04 if day.weekday() == 0 else 0 for day in dates[1:]]
        self.assertAlmostEqual(metrics["volatility"], expected.std() * 252 ** .5 * 100)
        self.assertAlmostEqual(metrics["beta"], expected.cov(market.iloc[1:]) / market.iloc[1:].var())
        self.assertIsNone(b.risk_metrics(holdings, {("stock", "OPEN"): benchmark}, benchmark)["volatility"])
        self.assertIsNone(b.risk_metrics(holdings, histories, benchmark, valuation_complete=False)["beta"])

    def test_transaction_history_requires_every_page(self):
        url = b.rh.urls.orders_url()
        next_url = f"{url}?cursor=two"
        first = SimpleNamespace(status_code=200, json=lambda: {"results": [{"id": "first"}], "next": next_url})
        last = SimpleNamespace(status_code=200, json=lambda: {"results": [{"id": "last"}], "next": None})
        with patch.object(b.rh.helper.SESSION, "get", side_effect=[first, last]):
            self.assertEqual(b.transaction_history(url), [{"id": "first"}, {"id": "last"}])
        with patch.object(b.rh.helper.SESSION, "get", side_effect=[first, SimpleNamespace(status_code=503)]):
            with self.assertRaisesRegex(ValueError, "history page is unavailable"):
                b.transaction_history(url)

    def test_cash_summary_uses_brokerage_balance_paid_interest_and_account_rate(self):
        self.profile_mock.return_value = {
            "account_number": "test", "portfolio_cash": "150.00", "cash_available_for_withdrawal": "125.00",
            "buying_power": "2000.00", "sweep_enabled": False, "sweep_enrolled": True,
        }

        def response(url, *, params, **kwargs):
            self.assertEqual(params["account_number"], "test")
            if url.endswith("/timeline_summary/"):
                payload = {"account_number": "test", "total_paid_interest": {"amount": "12.34", "currency_code": "USD"},
                           "interest_accrued": {"amount": "4.00", "currency_code": "USD"}}
            else:
                self.assertTrue(url.endswith("/interest/"))
                payload = {"interest_rate": "7.00", "gold_interest_rate": "3.60"}
            return SimpleNamespace(status_code=200, json=lambda: payload)

        with patch.object(b.rh.helper.SESSION, "get", side_effect=response):
            self.assertEqual(b.cash_summary(), {"balance": 150.0, "interestEarned": 12.34, "apy": 7.0})

    def test_missing_interest_is_distinct_from_a_zero_balance_and_unenrolled_rate(self):
        self.profile_mock.return_value = {"account_number": "test", "portfolio_cash": "0", "sweep_enrolled": False}
        with patch.object(b.rh.helper.SESSION, "get", return_value=SimpleNamespace(status_code=503)) as fetch:
            self.assertEqual(b.cash_summary(), {"balance": 0.0, "interestEarned": None, "apy": 0.0})
            fetch.assert_called_once()

    def test_stock_quote_batches_match_symbols_and_refresh_prices(self):
        positions = [
            {"instrument": url, "quantity": "2", "average_buy_price": "5"}
            for url in ("first", "missing", "last")
        ]
        instruments = {
            "first": {"symbol": "ONE", "simple_name": "First holding"},
            "missing": {"symbol": "TWO", "name": "Second holding"},
            "last": {"symbol": "THREE"},
        }
        quotes = [
            {"symbol": "THREE", "last_trade_price": "9", "last_extended_hours_trade_price": "10"},
            {"symbol": "ONE", "last_trade_price": "8", "last_extended_hours_trade_price": None},
        ]
        with patch.object(b.rh.account, "get_open_stock_positions", return_value=positions), \
             patch.object(b.rh.stocks, "get_instrument_by_url", side_effect=instruments.__getitem__) as resolve, \
             patch.object(b.rh.stocks, "get_quotes", side_effect=[quotes, [{"symbol": "ONE", "last_trade_price": "11"}]]) as fetch:
            first, missing, last = b.stock_holdings()
            self.assertEqual(first["name"], "First holding")
            self.assertEqual(first["currentValue"], 16)
            self.assertIsNone(missing["currentValue"])
            self.assertEqual(missing["costBasis"], 10)
            self.assertEqual(last["currentValue"], 20)
            self.assertEqual(b.instrument_symbol("first"), "ONE")
            self.assertEqual(b.stock_holdings()[0]["currentValue"], 22)
            self.assertEqual(resolve.call_count, 3)
            self.assertEqual(fetch.call_count, 2)
            fetch.assert_called_with(["ONE", "TWO", "THREE"])

    def test_reserved_crypto_is_included_and_failed_quote_is_null(self):
        position = {"currency": {"code": "BTC"}, "quantity": "1", "quantity_available": ".4",
                    "quantity_held_for_sell": ".6", "cost_bases": [{"direct_cost_basis": "50000", "direct_quantity": "1"}]}
        with patch.object(b.rh.crypto, "get_crypto_positions", return_value=[position]), \
             patch.object(b.rh.crypto, "get_crypto_quote", return_value={"mark_price": "60000"}):
            item = b.crypto_holdings()[0]
            self.assertEqual(item["quantity"], 1)
            self.assertEqual(item["currentValue"], 60000)
        with patch.object(b.rh.crypto, "get_crypto_positions", return_value=[position]), \
             patch.object(b.rh.crypto, "get_crypto_quote", side_effect=RuntimeError("offline")):
            item = b.crypto_holdings()[0]
            self.assertIsNone(item["currentPrice"])
            self.assertIsNone(item["currentValue"])
            self.assertEqual(item["costBasis"], 50000)

    def test_cancelled_partial_stock_fill_is_counted_and_deduplicated(self):
        order = {"id": "order", "instrument": "url", "state": "cancelled", "side": "buy", "fees": "1",
                 "executions": [{"id": "fill", "timestamp": "2025-01-01T12:00:00Z", "rounded_notional": "100", "quantity": "10"}]}
        events, issues = b.normalize_trades([order, order], symbol_resolver=lambda _: "OPEN")
        self.assertFalse(issues)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["amount"], -101)
        self.assertEqual(events[0]["quantity"], 10)

    def test_unfilled_crypto_request_is_never_treated_as_a_trade(self):
        events, issues = b.normalize_trades([{"state": "cancelled", "quantity": "10", "price": "10", "notional": "100"}], "crypto")
        self.assertEqual(events, [])
        self.assertFalse(issues)

    def test_stock_execution_date_uses_new_york_trading_day(self):
        order = {"instrument": "url", "side": "buy", "executions": [
            {"timestamp": "2025-01-02T00:30:00Z", "quantity": "1", "price": "10"}]}
        events, issues = b.normalize_trades([order], symbol_resolver=lambda _: "OPEN")
        self.assertFalse(issues)
        self.assertEqual(events[0]["date"], "2025-01-01")

    def test_crypto_and_dividend_dates_use_the_same_new_york_calendar(self):
        timestamp = "2025-07-02T00:30:00Z"
        order = {"currency_code": "BTC", "side": "buy", "executions": [
            {"timestamp": timestamp, "quantity": "1", "price": "10"}]}
        trades, trade_issues = b.normalize_trades([order], "crypto")
        dividends, dividend_issues = b.dividend_events([
            {"state": "paid", "paid_at": timestamp, "amount": "10", "symbol": "OPEN"},
            {"state": "paid", "payable_date": "2025-07-02", "amount": "10", "symbol": "OPEN"},
        ])
        self.assertFalse(trade_issues or dividend_issues)
        self.assertEqual([trades[0]["date"], *[d["date"] for d in dividends]],
                         ["2025-07-01", "2025-07-01", "2025-07-02"])

    def test_filled_stock_order_without_executions_flags_incomplete_history(self):
        events, issues = b.normalize_trades([{"state": "filled"}])
        self.assertEqual(events, [])
        self.assertTrue(issues)

    def test_crypto_pair_id_resolves_to_asset_currency(self):
        order = {"currency_pair_id": "pair", "side": "buy", "cumulative_quantity": "1", "average_price": "100",
                 "updated_at": "2025-01-01T12:00:00Z"}
        with patch.object(b.rh.crypto, "get_crypto_currency_pairs", return_value=[{"id": "pair", "asset_currency": {"code": "BTC"}}]):
            events, issues = b.normalize_trades([order], "crypto")
        self.assertFalse(issues)
        self.assertEqual(events[0]["symbol"], "BTC")
        self.assertEqual(events[0]["amount"], -100)

    def test_crypto_execution_uses_notional_and_effective_price_fields(self):
        order = {"currency_code": "BTC", "side": "buy", "fees": {"amount": "1", "currency_code": "USD"},
                 "executions": [{"id": "one", "timestamp": "2025-01-01T12:00:00Z", "quantity": ".01",
                                 "effective_price": "10000", "notional": "100"}]}
        events, issues = b.normalize_trades([order], "crypto")
        self.assertFalse(issues)
        self.assertEqual(events[0]["amount"], -101)
        self.assertEqual(events[0]["quantity"], .01)
        del order["executions"][0]["notional"]
        events, issues = b.normalize_trades([order], "crypto")
        self.assertFalse(issues)
        self.assertEqual(events[0]["amount"], -101)

    def test_crypto_currency_tagged_notional_and_sell_fee(self):
        order = {"currency_code": "ETH", "side": "sell", "fees": "2",
                 "executions": [{"timestamp": "2025-01-01T12:00:00Z", "quantity": ".1",
                                 "notional": {"amount": "100", "currency_code": "USD"}}]}
        events, issues = b.normalize_trades([order], "crypto")
        self.assertFalse(issues)
        self.assertEqual(events[0]["amount"], 98)
        self.assertEqual(events[0]["quantity"], -.1)

    def test_crypto_uses_final_order_cash_without_subcent_drift_or_double_fees(self):
        order = {"currency_code": "BTC", "side": "buy", "fees": "1", "rounded_executed_notional": "100.00",
                 "rounded_executed_notional_with_fee": "101.00", "executions": [
                    {"id": "a", "timestamp": "2025-01-01T12:00:00Z", "quantity": ".004", "notional": "40.0001"},
                    {"id": "b", "timestamp": "2025-01-01T12:00:01Z", "quantity": ".006", "notional": "59.9988"}]}
        events, issues = b.normalize_trades([order], "crypto")
        self.assertFalse(issues)
        self.assertAlmostEqual(sum(e["amount"] for e in events), -101)
        order.update(side="sell", rounded_executed_notional_with_fee="99.00")
        events, issues = b.normalize_trades([order], "crypto")
        self.assertFalse(issues)
        self.assertAlmostEqual(sum(e["amount"] for e in events), 99)

    def test_dividend_preference_is_not_confirmation_of_reinvestment(self):
        events, issues = b.dividend_events([{"state": "paid", "paid_at": "2025-01-01", "amount": "10",
                                           "withholding": "1", "symbol": "OPEN", "drip_enabled": True}])
        self.assertFalse(issues)
        self.assertEqual(events[0]["amount"], 9)
        self.assertFalse(events[0]["reinvested"])
        self.assertFalse(events[0]["reinvestmentKnown"])

    def test_pending_dividends_are_not_counted(self):
        events, _ = b.dividend_events([{"state": "pending", "amount": "10"}])
        self.assertEqual(events, [])

    def test_skipped_reinvestment_is_cash_even_when_drip_is_enabled(self):
        events, issues = b.dividend_events([{"state": "paid", "paid_at": "2025-08-15", "amount": "1.81",
            "gross_amount": "1.81", "symbol": "AAPL", "drip_enabled": True,
            "drip_order_state": None, "drip_skipped_reason": "insufficient_buying_power"}])
        self.assertFalse(issues)
        self.assertTrue(events[0]["reinvestmentKnown"])
        self.assertFalse(events[0]["reinvested"])
        self.assertEqual(events[0]["amount"], 1.81)

    def test_completed_drip_order_confirms_reinvestment_but_queued_order_does_not(self):
        dividend = {"state": "paid", "paid_at": "2025-01-01", "amount": "10", "symbol": "OPEN",
                    "drip_enabled": True, "drip_order_state": "filled"}
        events, _ = b.dividend_events([dividend])
        self.assertTrue(events[0]["reinvested"])
        self.assertTrue(events[0]["reinvestmentKnown"])
        dividend["drip_order_state"] = "queued"
        events, _ = b.dividend_events([dividend])
        self.assertFalse(events[0]["reinvestmentKnown"])

    def test_null_reinvestment_flag_does_not_confirm_cash_or_execution(self):
        events, _ = b.dividend_events([{"state": "paid", "paid_at": "2025-01-01", "amount": "10",
                                      "symbol": "OPEN", "reinvested": None}])
        self.assertFalse(events[0]["reinvestmentKnown"])

    def test_current_dividend_payload_uses_credited_amount_without_double_withholding(self):
        events, issues = b.dividend_events([{"state": "paid", "paid_at": "2025-01-01", "amount": "9",
                                           "gross_amount": "10", "withholding": "1", "symbol": "OPEN", "drip_enabled": False}])
        self.assertFalse(issues)
        self.assertEqual(events[0]["amount"], 9)
        self.assertTrue(events[0]["reinvestmentKnown"])

    def test_received_stock_reward_fills_missing_shares_without_inventing_a_cash_purchase(self):
        referrals = [{"id": "referral", "reward": {"stocks": [{"uuid": "award", "symbol": "OPEN", "quantity": .05,
            "cost_basis": "5", "received_at": "2025-01-01T15:00:00Z", "state": "received"}]}}]
        rewards = b.stock_reward_events(referrals + referrals)
        self.assertEqual(len(rewards), 1)
        self.assertEqual(rewards[0]["amount"], 0)
        self.assertEqual(rewards[0]["rewardValue"], 5)
        events = [trade("OPEN", "2025-06-01", -100, 10)]
        result = b.include_stock_rewards([holding(quantity=10.05)], events, rewards, {("stock", "OPEN"): history()})
        self.assertEqual(len(result), 2)
        self.assertEqual(sum(e["quantity"] for e in result), 10.05)
        self.assertEqual(sum(e["amount"] for e in result), -100)

    def test_stock_reward_already_in_orders_is_not_duplicated(self):
        rewards = [{"symbol": "OPEN", "assetType": "stock", "kind": "grant", "quantity": .05, "amount": 0,
                    "date": "2025-01-01", "rewardValue": 5}]
        events = [trade("OPEN", "2025-01-01", -100, 10)]
        self.assertEqual(b.include_stock_rewards([holding()], events, rewards, {("stock", "OPEN"): history()}), events)

    def test_unreceived_stock_reward_does_not_change_positions(self):
        self.assertEqual(b.stock_reward_events([{"reward": {"stocks": [
            {"symbol": "OPEN", "quantity": 1, "state": "pending", "received_at": None}]}}]), [])

    def test_nested_and_legacy_news_and_url_validation(self):
        news = b.normalize_news([
            {"content": {"title": "Headline", "canonicalUrl": {"url": "https://example.com/news"}, "provider": {"displayName": "Publisher"}}},
            {"title": "Legacy", "link": "https://example.com/old", "publisher": "Old"},
            {"title": "Duplicate link", "link": "https://example.com/news"},
            {"title": "Headline", "link": "https://example.com/syndicated"},
            {"title": "Bad", "link": "javascript:alert(1)"},
        ])
        self.assertEqual([n["title"] for n in news], ["Headline", "Legacy"])
        self.assertEqual(news[0]["publisher"], "Publisher")
        self.assertEqual(len(b.normalize_news([{"title": f"Headline {i}", "link": f"https://example.com/{i}"}
                                               for i in range(14)])), 10)

    def test_ticker_news_omits_unrelated_search_results_and_videos(self):
        news = [
            {"title": "Related", "link": "https://example.com/news", "relatedTickers": ["OPEN"], "type": "STORY"},
            {"title": "Unrelated", "link": "https://example.com/other", "relatedTickers": ["OTHER"]},
            {"title": "Video", "link": "https://example.com/video", "relatedTickers": ["OPEN"], "type": "VIDEO"},
        ]
        with patch.object(b.yf, "Search", return_value=SimpleNamespace(news=news)):
            self.assertEqual([item["title"] for item in b.ticker_news("OPEN")], ["Related"])

    def test_refresh_keeps_history_when_all_positions_are_closed(self):
        order = {"instrument": "url", "side": "buy", "executions": [{"timestamp": "2025-01-01T12:00:00Z", "quantity": "10", "rounded_notional": "100"}]}
        sale = {"instrument": "url", "side": "sell", "executions": [{"timestamp": "2025-06-01T12:00:00Z", "quantity": "10", "rounded_notional": "150"}]}
        voo_prices = history([100, 200, 300]).assign(**{"Adj Close": [80, 180, 300]})
        with patch.object(b, "stock_holdings", return_value=[]), patch.object(b, "crypto_holdings", return_value=[]), \
             patch.object(b, "transaction_history", side_effect=lambda url: [sale, order] if url == b.rh.urls.orders_url() else []), \
             patch.object(b, "instrument_symbol", return_value="OPEN"), \
             patch.object(b, "market_history", side_effect=lambda key, *_: voo_prices if key == ("stock", "VOO") else history()):
            data = b.load_portfolio(date(2026, 1, 1))
        self.assertEqual(data["totalProfitLoss"], 50)
        self.assertTrue(data["historicalData"])
        self.assertEqual(data["sp500"]["symbol"], "VOO")
        self.assertEqual(data["sp500"]["currentValue"], 75)

    def test_crypto_inventory_failure_does_not_report_partial_total_as_complete(self):
        with patch.object(b, "stock_holdings", return_value=[]), \
             patch.object(b, "crypto_holdings", side_effect=RuntimeError("offline")), \
             patch.object(b, "transaction_history", return_value=[]), \
             patch.object(b, "market_history", return_value=history()):
            data = b.load_portfolio(date(2026, 1, 1))
        self.assertIsNone(data["totalCurrentValue"])
        self.assertIsNone(data["totalProfitLoss"])
        self.assertTrue(data["warnings"])

    def test_detail_news_failure_does_not_hide_available_prices(self):
        class Ticker:
            info = {"longName": "Example"}
            recommendations_summary = pd.DataFrame([{"period": "0m", "buy": 10}, {"period": "-1m", "buy": 3}])
            def get_analyst_price_targets(self): return {"mean": 42.0, "low": 35.0, "high": 50.0}
        ticker = Ticker()
        with patch.object(b.yf, "Ticker", return_value=ticker), \
             patch.object(b.yf, "Search", side_effect=RuntimeError("offline")), \
             patch.object(ticker, "history", create=True, return_value=history()) as price_history:
            data = b.holding_detail("OPEN", "stock")
        price_history.assert_called_once_with(period="max", auto_adjust=True, timeout=15)
        self.assertEqual(len(data["prices"]), 3)
        self.assertEqual(data["analyst"]["sentiment"], "Buy")
        self.assertEqual(data["analyst"]["ratings"]["Buy"], 10)
        self.assertEqual(data["analyst"]["target"], {"mean": 42.0, "low": 35.0, "high": 50.0})
        self.assertEqual(data["news"], [])
        self.assertTrue(data["warnings"])


if __name__ == "__main__":
    unittest.main()
