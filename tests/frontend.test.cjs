const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = require('../static/app.js');

test('unknown money and returns stay unavailable while genuine zeros remain visible', () => {
  for (const value of [null, undefined, NaN, Infinity]) {
    assert.equal(app.usd(value), '—');
    assert.equal(app.pc(value), '—');
  }
  assert.equal(app.usd(0), '$0.00');
  assert.equal(app.pc(0), '+0.00%');
  assert.equal(app.val({}, 'week'), null);
  assert.equal(app.val({ week: 5.2 }, 'week'), 5.2);
  assert.equal(app.val({ returnPct: 50, investment: 25, profitLoss: 25 }, 'return'), 50);
});

test('holdings default to largest first and unknown values sort last in either direction', () => {
  const rows = [{ symbol: 'SMALL', currentValue: 10 }, { symbol: 'UNKNOWN', currentValue: null }, { symbol: 'BIG', currentValue: 100 }];
  assert.deepEqual(app.sortedHoldings(rows, 'currentValue', -1).map(r => r.symbol), ['BIG', 'SMALL', 'UNKNOWN']);
  assert.deepEqual(app.sortedHoldings(rows, 'currentValue', 1).map(r => r.symbol), ['SMALL', 'BIG', 'UNKNOWN']);
  assert.equal(rows[0].symbol, 'SMALL');
});

test('chart periods use the actual observation date and clamp short calendar months', () => {
  const rows = [{ date: '2024-02-28', portfolio: null }, { date: '2024-02-29', portfolio: 10 },
    { date: '2024-03-15', portfolio: 20 }, { date: '2024-03-31', portfolio: 30 }];
  assert.deepEqual(app.rangeRows(rows, '1M').map(r => r.date), ['2024-02-29', '2024-03-15', '2024-03-31']);
  assert.equal(app.rangeRows(rows, 'ALL').length, 4);
  assert.equal(app.rangeRows(rows, 'ALL')[0].portfolio, null);
  assert.deepEqual(app.rangeRows([], '1Y'), []);
});

test('holdings show all rows and search by ticker or name while sorting by total return', () => {
  const elements = {
    holdingsSearch: { value: '' }, holdingsScroll: {}, count: {}, holdingsEmpty: { classList: { toggle() {} } },
    holdings: { style: { removeProperty() {}, setProperty() {} }, replaceChildren(fragment) { this.rows = fragment.rows; } }
  };
  const document = {
    getElementById: id => elements[id], querySelectorAll: () => [],
    createDocumentFragment: () => ({ rows: [], append(row) { this.rows.push(row); } }),
    createElement: () => ({ querySelector: () => ({ addEventListener() {} }), getBoundingClientRect: () => ({ height: 70 }) })
  };
  const context = vm.createContext({ module: { exports: {} }, document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  vm.runInContext(`D = { stocks: Array.from({ length: 14 }, (_, i) => ({
    symbol: 'ASSET' + i, name: i < 2 ? 'Sample Fund' : 'Example Co',
    quantity: 2.345678, avgCost: .123456, currentPrice: .986432,
    currentValue: i + 1, returnPct: 30 - i, totalReturnPct: i
  })) }; holdings()`, context);
  assert.equal(elements.holdings.rows.length, 14);
  assert.match(elements.holdings.rows[0].innerHTML, /<td>2\.35<\/td><td>\$0\.12<\/td><td>\$0\.99<\/td>/);

  elements.holdingsSearch.value = '  aSsEt13  ';
  vm.runInContext('holdings()', context);
  assert.equal(elements.holdings.rows.length, 1);
  assert.match(elements.holdings.rows[0].innerHTML, /ASSET13/);

  elements.holdingsSearch.value = 'sample';
  vm.runInContext('sorting("totalReturnPct")', context);
  assert.equal(elements.holdings.rows.length, 2);
  assert.match(elements.holdings.rows[0].innerHTML, /<b>ASSET1<\/b>.*\+1\.00%/);
  vm.runInContext('sorting("totalReturnPct")', context);
  assert.match(elements.holdings.rows[0].innerHTML, /<b>ASSET0<\/b>.*\+0\.00%/);

  elements.holdingsSearch.value = 'missing';
  vm.runInContext('holdings()', context);
  assert.equal(elements.holdings.rows.length, 0);
  assert.match(elements.holdingsEmpty.textContent, /No holdings match/);
});

test('portfolio insights rank total returns and interpret the matched VOO risk measures', () => {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  };
  const context = vm.createContext({ module: { exports: {} }, document: { getElementById } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  vm.runInContext(`D = { stocks: [
    { symbol: "FUND", currentValue: 850, totalReturnPct: 20, returnPct: -1 },
    { symbol: "TEST", currentValue: 100, totalReturnPct: -5, returnPct: 30 },
    { symbol: "MISSING", currentValue: 50, totalReturnPct: null }
  ], insights: { alpha: -.01, largestStockSector: { name: "Technology", weight: 10 }, diversification: 1.4,
    risk: { alpha: 3, volatility: 12, drawdown: -7, sharpe: .8, beta: 1,
      benchmark: { volatility: 10, drawdown: -8, sharpe: .9 } } } }; insights()`, context);
  const cards = getElementById('insights').innerHTML;
  assert.deepEqual(Array.from(cards.matchAll(/<h3>(.*?)<\/h3>/g), match => match[1]), [
    'Top performer', 'Worst performer', 'Largest sector', 'Alpha', 'Diversification',
    'Volatility', 'Max drawdown', 'Sharpe ratio', 'Beta vs S&amp;P 500'
  ]);
  assert.match(cards, /\+20\.00%[\s\S]*FUND/);
  assert.match(cards, /-5\.00%[\s\S]*TEST/);
  assert.match(cards, /10\.00%[\s\S]*Technology/);
  assert.match(cards, /\+3\.00 pp[\s\S]*Above model/);
  assert.match(cards, /More volatile than VOO/);
  assert.match(cards, /Shallower than VOO/);
  assert.doesNotMatch(cards, /MISSING/);
  vm.runInContext('D.insights.risk.benchmark = null; insights()', context);
  assert.match(getElementById('insights').innerHTML, /VOO reference unavailable/);
});

test('cash flows sum buys and sales through the selected months, including across years', () => {
  const select = () => ({ value: '', options: [], set innerHTML(html) {
    this.options = Array.from(html.matchAll(/<option(?: value="([^"]+)")?>([^<]+)<\/option>/g),
      ([, value, text]) => ({ value: value || text, text }));
  } });
  const elements = { cashFlowStartMonth: select(), cashFlowStartYear: select(),
    cashFlowEndMonth: select(), cashFlowEndYear: select(), flows: {} };
  const { cashFlowStartMonth: startMonth, cashFlowStartYear: startYear,
    cashFlowEndMonth: endMonth, cashFlowEndYear: endYear } = elements;
  const context = vm.createContext({ module: { exports: {} }, document: { getElementById: id => elements[id] } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  vm.runInContext(`D = { asOf: '2026-03-15', tradeHistoryComplete: true, cashFlowTransactions: [
    { date: '2025-11-30', kind: 'buy', amount: -500 }, { date: '2025-12-01', kind: 'buy', amount: -90 },
    { date: '2025-12-31', kind: 'sell', amount: 8 }, { date: '2026-01-01', kind: 'buy', amount: -11 },
    { date: '2026-02-28', kind: 'sell', amount: 9 }, { date: '2026-02-28', kind: 'dividend', amount: 50 },
    { date: '2026-03-15', kind: 'buy', amount: -1, assetType: 'crypto' }, { date: '2026-03-16', kind: 'buy', amount: -100 }
  ] }; flows()`, context);
  assert.deepEqual([startYear.value, startMonth.value, endYear.value, endMonth.value], ['2026', '01', '2026', '03']);
  assert.equal(startMonth.options[0].text, 'Jan');
  assert.equal(endMonth.options[3].disabled, true);
  assert.match(elements.flows.innerHTML, /Invested[\s\S]*pos">\$12\.00[\s\S]*Sold[\s\S]*neg">\$9\.00[\s\S]*Net[\s\S]*pos">\$3\.00/);

  startYear.value = '2025';
  startMonth.value = '12';
  endMonth.value = '02';
  vm.runInContext('flows()', context);
  assert.match(elements.flows.innerHTML, /Invested[\s\S]*\$101\.00[\s\S]*Sold[\s\S]*\$17\.00[\s\S]*Net[\s\S]*\$84\.00/);
  startYear.value = '2026';
  startMonth.value = '02';
  vm.runInContext('flows()', context);
  assert.match(elements.flows.innerHTML, /Net[\s\S]*neg">-\$9\.00/);
  vm.runInContext('D.tradeHistoryComplete = false; flows()', context);
  assert.equal([...elements.flows.innerHTML.matchAll(/muted">—/g)].length, 3);
});

test('heatmap tiles fill the plot with area proportional to position value', () => {
  const holdings = [60, 25, 10, 5].map(currentValue => ({ currentValue }));
  for (const [width, height] of [[1000, 400], [300, 380]]) {
    const tiles = app.heatmapLayout(holdings, width, height);
    assert.equal(tiles.length, holdings.length);
    for (const [index, tile] of tiles.entries()) {
      assert.ok(Math.abs(tile.width * tile.height / (width * height) - tile.item.currentValue / 100) < 1e-10);
      assert.ok(tile.x >= 0 && tile.y >= 0);
      assert.ok(tile.x + tile.width <= width + 1e-8 && tile.y + tile.height <= height + 1e-8);
      assert.ok(tiles.slice(index + 1).every(other =>
        tile.x + tile.width <= other.x + 1e-8 || other.x + other.width <= tile.x + 1e-8 ||
        tile.y + tile.height <= other.y + 1e-8 || other.y + other.height <= tile.y + 1e-8));
    }
  }
});

test('stock sectors combine position values and retain unclassified holdings', () => {
  const holdings = [{ symbol: 'A', sector: 'Technology', currentValue: 20 },
    { symbol: 'B', sector: 'Energy', currentValue: 30 },
    { symbol: 'C', sector: 'Technology', currentValue: 15 },
    { symbol: 'D', currentValue: 10 }];
  const sectors = app.heatmapSectors(holdings);
  assert.deepEqual(sectors.map(({ name, currentValue }) => [name, currentValue]),
    [['Technology', 35], ['Energy', 30], ['Uncategorized', 10]]);
  assert.deepEqual(sectors[0].holdings.map(holding => holding.symbol), ['A', 'C']);
});

test('heatmap reserves room for labels even with highly uneven position values', () => {
  const holdings = [{ sector: 'Technology', currentValue: 950 }, { sector: 'Technology', currentValue: 1 },
    { sector: 'Financial Services', currentValue: 20 }, { sector: 'Energy', currentValue: 1 }];
  const groups = app.heatmapSectors(holdings);
  const layout = app.readableHeatmapLayout(groups, 900, 390, true);
  assert.ok(layout);
  assert.deepEqual(layout.flatMap(group => group.tiles.map(tile => tile.item)), groups.flatMap(group => group.holdings));
  assert.ok(layout.flatMap(group => group.tiles).every(tile => tile.width >= 96 && tile.height >= 62));
  assert.equal(app.readableHeatmapLayout(groups, 175, 110, true), null);
});

test('performance chart shows both series and compares current values against VOO', () => {
  const charts = [], elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '' });
    return elements.get(id);
  };
  class Chart { constructor(canvas, config) { charts.push(config); } destroy() {} }
  const context = { module: { exports: {} }, console, URL, Chart,
    getComputedStyle: () => ({ getPropertyValue: key => key === '--comparison' ? '#6f42b4' : '#50755c' }),
    document: { getElementById: element, documentElement: {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  vm.runInContext(`D = { totalCurrentValue: 120, sp500: {currentValue: 100, xirr: .075}, historicalData: [
    {date: "2026-01-01", portfolio: null, sp500: 10}, {date: "2026-11-01", portfolio: 120, sp500: 100}
  ] }; performanceMetrics(); performanceChart()`, context);
  const datasets = charts.at(-1).data.datasets;
  assert.deepEqual(Array.from(datasets, series => series.label), ['Portfolio', 'VOO']);
  assert.deepEqual(Array.from(datasets[0].data), [null, 120]);
  assert.deepEqual(Array.from(datasets[1].data), [10, 100]);
  assert.equal(datasets[1].borderColor, '#6f42b4');
  assert.equal(element('performancePortfolioValue').textContent, '$120.00');
  assert.equal(element('performanceVooValue').textContent, '$100.00');
  assert.equal(element('performanceVooXirr').textContent, '+7.50%');
  assert.equal(element('performanceValueGap').textContent, '+20.00%');
  vm.runInContext('D.sp500.currentValue = 150; performanceMetrics()', context);
  assert.equal(element('performanceValueGap').textContent, '-20.00%');
  vm.runInContext('D.sp500.currentValue = 0; performanceMetrics()', context);
  assert.equal(element('performanceValueGap').textContent, '—');
});

test('six-month history cannot claim multi-year CAGR periods', () => {
  const periods = app.cagrPeriods([{ date: '2025-07-01', close: 100 }, { date: '2026-01-01', close: 110 }]);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].label, 'Since inception (annualized)');
  assert.ok(periods[0].value > 20 && periods[0].value < 22);
});

test('CAGR uses the actual final observation rather than the wall clock', () => {
  const periods = app.cagrPeriods([{ date: '2020-01-01', close: 100 }, { date: '2024-01-01', close: 110 }, { date: '2025-01-01', close: 121 }]);
  assert.equal(periods.find(p => p.label === '1Y CAGR').value.toFixed(1), '10.0');
  assert.ok(periods.some(p => p.label === '5Y CAGR'));
  assert.ok(!periods.some(p => p.label === '10Y CAGR'));
});

test('news URLs reject executable and non-HTTP schemes; dynamic text is escaped', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '/relative', null]) assert.equal(app.safeLink(value), null);
  assert.equal(app.safeLink('https://example.com/news'), 'https://example.com/news');
  assert.ok(app.clean(`<img onerror="alert('x')">`).includes('&lt;img'));
  assert.ok(!app.clean(`<img onerror="alert('x')">`).includes('<'));
});

test('analyst sentiment groups strong ratings and compares the target to the holding price', () => {
  const panel = {};
  const context = vm.createContext({ module: { exports: {} }, document: { getElementById: () => panel } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  vm.runInContext(`showAnalyst({ sentiment: 'Buy', currency: 'USD',
    ratings: { 'Strong buy': 3, Buy: 2, Hold: 4, 'Strong sell': 1 },
    target: { mean: 120, low: 95, high: 160 } }, 'stock', 'SAMPLE', 100)`, context);
  assert.match(panel.innerHTML, /analyst-buy" x="0" width="50"/);
  assert.match(panel.innerHTML, /analyst-hold" x="50" width="40"/);
  assert.match(panel.innerHTML, /analyst-sell" x="90" width="10"/);
  assert.match(panel.innerHTML, /\$120\.00[\s\S]*\+20\.00%[\s\S]*\$95\.00 to \$160\.00/);
});

test('HTML loads one application script and has no inline application handlers', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.equal((html.match(/src="\/static\/app.js"/g) || []).length, 1);
  assert.doesNotMatch(html, /\bon(click|change)=/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('Atlas history includes closed securities and keeps Robinhood positions and asset types', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/atlas.js'), 'utf8'), context);
  const index = vm.runInContext(`Atlas.buildIndex([{symbol: 'VOO', name: 'Vanguard', assetType: 'etf'}], [
    {symbol: 'VOO', assetType: 'stock', date: '2026-01-05'},
    {symbol: 'VOO', assetType: 'stock', date: '2025-12-01'},
    {symbol: 'CLOSED', assetType: 'stock', date: '2026-02-01'},
    {symbol: 'BTC', assetType: 'crypto', date: '2026-01-01'}
  ])`, context);
  assert.deepEqual(Array.from(index, row => [row.symbol, row.assetType, row.open, row.activityCount]),
    [['BTC', 'crypto', false, 1], ['CLOSED', 'stock', false, 1], ['VOO', 'etf', true, 2]]);
  assert.equal(index.at(-1).lastActivity, '2026-01-05');
});

test('Atlas valuation uses implied earnings and reports partial coverage', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/atlas.js'), 'utf8'), context);
  const result = vm.runInContext(`Atlas.valuation([
    {assetType: 'stock', currentValue: 100, trailingPE: 10},
    {assetType: 'stock', currentValue: 200, trailingPE: 20},
    {assetType: 'stock', currentValue: 50, trailingPE: null},
    {assetType: 'etf', currentValue: 300, trailingPE: 25}
  ])`, context);
  assert.equal(result.equity, 350);
  assert.equal(result.covered, 300);
  assert.equal(result.pe, 15);
});

test('Atlas renders the Robinhood history inspector and routes the VOO chart to overview', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '',
      classList: { toggle() {}, remove() {}, contains: () => true }, parentElement: { classList: { toggle() {} } },
      setAttribute() {}, replaceChildren() {} });
    return elements.get(id);
  };
  const views = ['overview', 'overview', 'history', 'holdings', 'activity', 'allocation performance watchlist'].map(view => ({
    dataset: { atlasView: view }, hidden: false, classList: { toggle(_, hidden) { this.owner.hidden = hidden; } }
  }));
  for (const view of views) view.classList.owner = view;
  const context = vm.createContext({
    module: { exports: {} }, AbortController, Option: class {},
    document: { getElementById: element, querySelectorAll: selector => selector === '[data-atlas-view]' ? views : [] },
    location: { hash: '#history' }, window: { scrollTo() {} }, Research: { setWorkspace() {} }
  });
  element('detail').classList.contains = () => true;
  element('atlasHistoryRange').value = 'ALL';
  element('atlasActivityKind').value = 'all';
  element('atlasValuationBand').value = 'all';
  for (const file of ['app.js', 'atlas.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', file), 'utf8'), context);
  vm.runInContext(`Atlas.setPortfolio({
    stocks: [{ symbol: 'ABC', assetType: 'stock', currentValue: 100, name: 'Test stock', trailingPE: 25 }],
    asOf: '2026-01-02', totalCurrentValue: 100, cashSummary: { balance: 100 },
    historicalData: [{ date: '2026-01-02', portfolio: 100, netInvestment: 80 }],
    cashFlowTransactions: [{ date: '2026-01-02', symbol: 'ABC', assetType: 'stock', kind: 'buy', quantity: 1, amount: -80 }]
  }); Atlas.route()`, context);
  assert.equal(element('atlasTitle').textContent, 'Portfolio history');
  assert.match(element('atlasDayDetail').innerHTML, /ABC[\s\S]*Buy[\s\S]*-\$80\.00/);
  assert.match(element('atlasClosingLedger').innerHTML, /\$100\.00/);
  assert.deepEqual(views.filter(view => !view.hidden).map(view => view.dataset.atlasView), ['history']);
  vm.runInContext(`api = async () => ({data: []}); location.hash = '#overview'; Atlas.route()`, context);
  assert.deepEqual(views.filter(view => !view.hidden).map(view => view.dataset.atlasView), ['overview', 'overview']);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /data-atlas-view="overview">\s*<section class="performance-panel"[\s\S]*?Performance vs VOO/);
});

test('a slow detail response cannot overwrite a subsequently selected holding', async () => {
  const pending = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', children: [], classList: { add() {}, remove() {}, toggle() {} },
      replaceChildren() { this.children = []; this.innerHTML = ''; }, append(child) { this.children.push(child); } });
    return elements.get(id);
  };
  const context = { module: { exports: {} }, console, URL, AbortController, setInterval, clearInterval, scrollTo() {},
    document: { getElementById: element }, fetch: url => new Promise(resolve => pending.push({ url, resolve })) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  const first = vm.runInContext('openHolding("FIRST")', context);
  const second = vm.runInContext('openHolding("SECOND")', context);
  const response = company => ({ ok: true, json: async () => ({ success: true, data: {
    company, source: 'Fixture', prices: [], news: [], warnings: [] } }) });
  pending[1].resolve(response('Second company'));
  await second;
  pending[0].resolve(response('First company'));
  await first;
  assert.equal(element('symbol').textContent, 'SECOND');
  assert.equal(element('name').textContent, 'Second company');
  assert.equal([...element('numbers').innerHTML.matchAll(/class="summary-tile"/g)].length, 8);
  assert.deepEqual([...element('cagr').innerHTML.matchAll(/<h3>([^<]+)<\/h3>/g)].map(match => match[1]),
    ['1Y CAGR', '5Y CAGR', '10Y CAGR', '15Y CAGR', 'Lifetime CAGR']);
});
