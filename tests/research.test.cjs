"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { exposure, tradePreview, reviewSignal, returnDrivers, peerMedian } = require("../static/research.js");

const apple = { symbol: "AAPL", assetType: "stock", currentValue: 100, sector: "Technology" };
const voo = { symbol: "VOO", assetType: "etf", currentValue: 200 };
const bitcoin = { symbol: "BTC", assetType: "crypto", currentValue: 50 };
const holdings = [apple, voo, bitcoin];
const funds = new Map([["VOO", {
  holdings: [{ symbol: "AAPL", weight: 0.05 }],
  sectors: { technology: 0.4, financial_services: 0.2 }
}]]);

test("company exposure includes direct and partial ETF holdings, with cash and crypto in the denominator", () => {
  const book = exposure(holdings, 50, funds);
  assert.equal(book.total, 400);
  assert.equal(book.companies.get("AAPL").total, 110);
  assert.equal(book.companies.get("AAPL").via.get("VOO"), 10);
  assert.equal(book.sectors.get("technology"), 180);
  assert.equal(book.coverage[0].covered, 0.05);
  assert.equal(exposure(holdings, null, funds).total, null);
});

test("a cash-funded hypothetical trade updates the relevant exposures without changing total value", () => {
  const purchase = tradePreview(holdings, 50, funds, voo, "buy", 40);
  assert.equal(purchase.before.total, purchase.after.total);
  assert.equal(purchase.after.groups.cash, 10);
  assert.equal(purchase.after.companies.get("AAPL").total, 112);
  const sale = tradePreview(holdings, 50, funds, bitcoin, "sell", 50);
  assert.equal(sale.after.groups.cash, 100);
  assert.equal(sale.after.groups.crypto, 0);
  assert.ok(tradePreview(holdings, 50, funds, bitcoin, "sell", 51).error);
  assert.ok(tradePreview(holdings, 50, funds, apple, "buy", 51).error);
  assert.ok(tradePreview(holdings, null, funds, apple, "buy", 1).error);
});

test("review signals explain known exposure caps and require confirming inputs before an add", () => {
  const book = exposure(holdings, 50, funds);
  const quote = { close: 110, sma200: 100, relative3m: 3, benchmark: "VOO", forwardPE: 20 };
  assert.match(reviewSignal(apple, book, { company: 26 }, quote, 25).join(" "), /Review trim.+27.50%/);
  assert.equal(reviewSignal(apple, book, { stock: 35 }, quote, 25)[0], "Review add");
  assert.equal(reviewSignal(apple, book, { stock: 35 }, quote, null)[0], "Watch");
  assert.equal(reviewSignal(apple, book, { stock: 35 }, { ...quote, relative3m: -1 }, 25)[0], "Watch");
  assert.equal(reviewSignal(bitcoin, book, { crypto: 25 }, { ...quote, benchmark: "BTC" }, null)[0], "Review add");
});

test("peer median uses other tracked equities in the same industry", () => {
  const quote = { symbol: "AAPL", industry: "Hardware", assetType: "stock", forwardPE: 29 };
  const snapshots = new Map([
    ["stock:AAPL", quote],
    ["stock:PEER1", { ...quote, symbol: "PEER1", forwardPE: 15 }],
    ["stock:PEER2", { ...quote, symbol: "PEER2", forwardPE: 25 }],
    ["stock:OTHER", { ...quote, symbol: "OTHER", industry: "Energy", forwardPE: 60 }]
  ]);
  assert.equal(peerMedian(quote, snapshots), 20);
});

test("return drivers sum monthly amounts across years and never turn missing marks into zero", () => {
  const report = [
    { month: "2025-12", assets: [{ symbol: "CLOSED", assetType: "stock", value: -40 }] },
    { month: "2026-01", assets: [{ symbol: "CLOSED", assetType: "stock", value: 10 }, { symbol: "BTC", assetType: "crypto", value: 20 }] },
    { month: "2026-02", assets: [{ symbol: "BTC", assetType: "crypto", value: null }] }
  ];
  assert.deepEqual(returnDrivers(report, "2025-12", "2026-01").map(row => [row.symbol, row.value]), [["CLOSED", -30], ["BTC", 20]]);
  assert.equal(returnDrivers(report, "2025-12", "2026-02"), null);
});
