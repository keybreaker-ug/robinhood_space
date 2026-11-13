const test = require('node:test');
const assert = require('node:assert/strict');

test('Atlas ETF look-through weights the equity sleeve and preserves unclassified ETF value', async () => {
  const { sectorAllocation } = await import('../static/portfolio-atlas/model.js');
  const model = { equity: [{ value: 40, sector: 'Technology' }], funds: [{ symbol: 'MIX', value: 50 }],
    fundValue: 50, crypto: [{ value: 10 }] };
  const allocation = sectorAllocation(model, new Map([['MIX', { stockWeight: 0.8,
    sectors: { technology: 0.5, financial_services: 0.25 } }]]));
  assert.deepEqual(allocation, { rows: [{ name: 'Technology', value: 60 },
    { name: 'Financial Services', value: 10 }, { name: 'Non-stock ETF exposure', value: 10 }, { name: 'Unclassified ETF exposure', value: 10 },
    { name: 'Crypto', value: 10 }], covered: 30 });
  assert.equal(sectorAllocation(model, new Map()).covered, 0);
});

test('Atlas Overview and Allocation show the same ETF-inclusive sector percentages', async () => {
  const { overview, allocation } = await import('../static/portfolio-atlas/views.js');
  const { sectorAllocation } = await import('../static/portfolio-atlas/model.js');
  const fund = { symbol: 'MIX', label: 'Mix ETF', isin: 'etf:MIX', value: 76, weight: 76 };
  const model = { scope: 'all', selected: [], total: 100, equityValue: 14, fundValue: 76, top10: 100,
    indices: [], rows: [fund], shared: [], cap: [], sector: [{ name: 'Technology', value: 14, weight: 14 }],
    equity: [{ sector: 'Technology', value: 14 }],
    funds: [fund], crypto: [{ value: 10 }] };
  model.lookThrough = sectorAllocation(model, new Map([['MIX', { stockWeight: 1,
    sectors: { technology: 0.5, financial_services: 0.5 } }]]));
  const state = { scope: 'all', page: 'overview', benchmark: 'S&P 500', marketRange: '1Y', vooRange: '1Y' };
  const summary = overview(state, model, {}, { all: model });
  assert.match(summary, /Technology<\/span><b>52\.00%<\/b>/);
  assert.match(summary, /Financial Services<\/span><b>38\.00%<\/b>/);
  assert.match(summary, /data-atlas-style="width:52%"/);
  assert.doesNotMatch(summary, /Technology<\/span><b>14\./);
  assert.match(allocation({ ...state, page: 'allocation', scenarioSector: 'all', scenarioShock: -10 }, model),
    /Technology<\/span><b>\$52<\/b><small>52\.00%/);
});

test('Atlas CAGR uses adjusted prices and shows only periods with sufficient history', async () => {
  const { cagrPeriods } = await import('../static/portfolio-atlas/model.js');
  const rates = cagrPeriods([['2021-02-26', 500, 100], ['2025-02-28', 1000, 150], ['2026-02-28', 170, 165]]);
  assert.ok(Math.abs(rates.get('1Y') - 10) < 0.02);
  assert.ok(rates.has('5Y'));
  assert.ok(rates.has('Lifetime'));
  assert.equal(rates.has('10Y'), false);
  assert.equal(rates.has('15Y'), false);
});

test('Atlas 5Y chart and change use five calendar years while All includes earlier prices', async () => {
  const { inRange } = await import('../static/portfolio-atlas/model.js');
  const { seriesChange } = await import('../static/portfolio-atlas/chart.js');
  const prices = [['2016-02-29', 10], ['2019-02-27', 40], ['2019-02-28', 60], ['2024-02-29', 120]];
  assert.deepEqual(inRange(prices, '5Y'), prices.slice(2));
  assert.deepEqual(inRange(prices, 'All'), prices);
  assert.deepEqual(inRange(prices.slice(2), '5Y'), prices.slice(2));
  assert.equal(seriesChange(prices, '5Y').change, 100);
  assert.equal(seriesChange(prices, 'All').change, 1100);
});

test('Holding comparisons use the full shared history and adjusted holding prices', async () => {
  const { adjustedCloseField, seriesChange } = await import('../static/portfolio-atlas/chart.js');
  const { drawResearch } = await import('../static/portfolio-atlas/research.js');
  const prices = [['2015-01-02', 30, 10], ['2020-01-06', 50, 40], ['2025-01-02', 80, 80], ['2025-01-04', 100, 100]];
  const comparison = [['2010-01-04', 20], ['2015-01-02', 30], ['2020-01-06', 45], ['2025-01-02', 60]];
  const all = seriesChange(prices, 'All', adjustedCloseField, comparison);
  const five = seriesChange(prices, '5Y', adjustedCloseField, comparison);
  assert.equal(all.first[0], '2015-01-02');
  assert.equal(all.change, 700);
  assert.equal(five.first[0], '2020-01-06');
  assert.equal(five.change, 100);
  assert.equal(five.last[0], '2025-01-02');
  assert.equal(seriesChange(prices, 'All', adjustedCloseField, []).first, undefined);
  for (const [assetType, asset] of [['stock','Equity'], ['etf','MF/ETF'], ['crypto','Crypto']]) {
    const row = { assetType, asset, isin: assetType+':ABC', symbol: 'ABC', label: 'Example', positions: [] };
    const research = { tab: 'chart', range: 'All', priceMode: 'compare', data: { chart: { points: prices } } };
    const html = drawResearch({watch:new Set()}, row, research, {points:comparison});
    assert.match(html, /data-value="compare" aria-pressed="true"/);
    assert.doesNotMatch(html, /data-value="(?:close|adjusted)"/);
    assert.match(html, /id="security-chart"/);
    assert.match(html, /Jan 2, 2015 to Jan 2, 2025/);
  }
});

test('Atlas renders Total return in holdings and heatmaps and uses position size for heat color', async () => {
  const { holdingRows, heatmaps } = await import('../static/portfolio-atlas/views.js');
  globalThis.matchMedia = () => ({ matches: false });
  const row = { isin: 'stock:ABC', symbol: 'ABC', name: 'Example', label: 'Example', asset: 'Equity',
    value: 100, qty: 2, cmp: 50, cost: 60, avgBuyPrice: 30, gain: 40, totalReturn: -15,
    timeHeld: '1 year, 2 months', weight: 100, sector: 'Technology' };
  const model = { rows: [row], equity: [row], sector: [{ name: 'Technology' }] };
  const state = { page: 'holdings', query: '', asset: 'all', sector: 'all', peBand: 'all', dataFilter: 'all',
    sort: { key: 'value', dir: -1 }, tablePage: 0, heatAsset: 'stocks', heatSector: 'all', heatStockMode: 'totalReturn' };
  const holdings = holdingRows(state, model, false);
  assert.match(holdings, /Avg buy price.*Cost basis.*Total return.*Time held/);
  assert.match(holdings, /−15\.00%/);
  assert.match(holdings, /<span>1 year<\/span><span>2 months<\/span>/);
  assert.doesNotMatch(holdings, /Open return/);
  const heat = heatmaps({ ...state, page: 'heatmaps' }, model);
  for (const label of ['1-week move', '1-month move', 'Current value', 'Total return']) assert.ok(heat.includes(label));
  assert.match(heat, /class="heat-tile heat-weight-3 .*Total return −15\.00%/);
  assert.doesNotMatch(heat, /Open return/);
});

test('Atlas holdings render all matching rows and global search works without the index page', async () => {
  const { holdingRows, pageHeader, nav } = await import('../static/portfolio-atlas/views.js');
  const { buildHoldingIndex, lookup } = await import('../static/portfolio-atlas/holding-index.js');
  const rows = Array.from({length: 30}, (_, i) => ({
    isin: 'stock:TEST' + i, symbol: 'TEST' + i, label: 'Example ' + i, name: 'Example ' + i,
    asset: 'Equity', value: i, positions: [{account: 1}]
  }));
  const model = { rows, selected: [{recon: {}}] };
  model.holdingIndex = buildHoldingIndex(model);
  const state = {page: 'holdings', query: '', asset: 'all', sector: 'all', peBand: 'all', dataFilter: 'all',
    sort: {key: 'value', dir: -1}, watch: new Set()};
  const holdings = holdingRows(state, model, false);
  assert.equal((holdings.match(/<tr data-row=/g) || []).length, 30);
  assert.equal(lookup(model.holdingIndex, 'TEST').length, 30);
  assert.match(holdings, /class="table-scroll"/);
  assert.doesNotMatch(holdings, /Previous page|Next page/);
  assert.doesNotMatch(nav(state, model), /Holdings index/);
  assert.doesNotMatch(pageHeader(state), /Robinhood/);
});
