export const sum = (rows, key) => rows.reduce((total, row) => total + (typeof key === 'function' ? key(row) : row[key] ?? 0), 0);
export const div = (a, b) => b ? a / b : null;
export const percent = (a, b) => Number.isFinite(a) && b > 0 ? 100 * a / b : null;
export const by = (rows, key) => Map.groupBy(rows, typeof key === 'function' ? key : row => row[key]);

export function parseDate(value) {
  if (!value) return null;
  const parts = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const ts = parts ? Date.UTC(+parts[3], +parts[2] - 1, +parts[1]) : Date.parse(value.replace(/^(\d{1,2})[ -]([a-z]{3})[ -](\d{4}).*$/i, '$1 $2 $3 UTC'));
  return Number.isFinite(ts) ? ts : null;
}

const day = 86400000;
function annualize(flows, date, terminal) {
  if (!flows.length || terminal <= 0) return null;
  const terms = flows.map(f => [f.amount, (date - f.date) / (365 * day)]);
  const valueAt = rate => sum(terms, ([amount, years]) => amount * Math.exp(rate * years));
  let low = -20;
  let high = 20;
  if (valueAt(low) >= terminal || valueAt(high) <= terminal) return null;
  for (let i = 0; i < 68; i++) {
    const mid = (low + high) / 2;
    if (valueAt(mid) < terminal) low = mid;
    else high = mid;
  }
  return Math.expm1((low + high) / 2) * 100;
}

function enrich(account) {
  const end = parseDate(account.meta.date);
  for (const row of account.holdings) {
    const datedLots = (account.lots[row.isin] ?? []).flatMap(lot => {
      const date = parseDate(lot.date);
      return date !== null && date < end && lot.rate > 0 && lot.qty > 0
        ? [{amount: lot.rate * lot.qty, date, event: lot.corp}] : [];
    });
    const equity = row.asset === 'Equity';
    row.lotFlows = equity && row.cur_value > 0 ? datedLots : [];
    const purchases = row.lotFlows.filter(lot => lot.event === 'T');
    const outlay = sum(purchases, 'amount');
    const matches = row.cost_value > 0 && Math.abs(outlay - row.cost_value) <= Math.max(10, .01 * row.cost_value);
    row.tradeFlows = matches && row.live ? purchases : [];
    row.xirr = row.brokerXirr;
    row.tradeXirr = annualize(row.tradeFlows, end, row.cur_value);
    row.navType = row.assetType === 'crypto' ? 'Crypto' : equity ? 'Stock' : 'ETF';
    row.label = row.fundStatement?.scheme ?? row.fund?.name ?? row.name;
  }
}

function aggregate(positions, total, end) {
  const latest = positions.slice().sort((a,b) => Number(b.live) - Number(a.live) || (b.snapshotAt || '').localeCompare(a.snapshotAt || '') || a.account - b.account)[0];
  const valued = positions.filter(p => p.cur_value != null);
  const knownCost = positions.filter(p => p.cost_value != null);
  const covered = knownCost.filter(p => p.cur_value != null);
  const quotes = positions.filter(p => p.day_chg != null && p.previousClose > 0);
  const gains = sum(covered, p => p.cur_value - p.cost_value);
  const value = valued.length ? sum(valued,'cur_value') : null;
  const cost = knownCost.length ? sum(knownCost,'cost_value') : null;
  const session = quotes.length ? sum(quotes,'day_chg') : null;
  const previousValue = sum(quotes,p => p.cur_value - p.day_chg);
  const lotRows = positions.filter(p => p.xirr != null && p.lotFlows.length);
  const tradeRows = positions.filter(p => p.tradeXirr != null);
  const lotValue = sum(lotRows,'cur_value');
  const tradeValue = sum(tradeRows,'cur_value');
  const reported = positions.filter(p => p.xirr != null);
  const xirr = reported.length === 1 ? reported[0].xirr : null;
  return {
    ...latest, positions, value, cost, session, previousValue, xirr,
    xirrValue: reported.length === 1 ? reported[0].cur_value : 0,
    tradeXirr: annualize(tradeRows.flatMap(p => p.tradeFlows), end, tradeValue),
    tradeXirrValue: tradeValue,
    transferLots: lotRows.some(p => p.lotFlows.some(lot => lot.event === 'Offmarket')),
    gain: covered.length ? gains : null, gainPct: percent(gains,sum(covered,'cost_value')),
    weight: percent(value,total), move: session == null ? null : percent(session,previousValue),
    coveredValue: sum(covered,'cur_value'), quoteValue: sum(quotes,'cur_value'),
    valued: valued.length, costCount: knownCost.length, qty: sum(positions,'qty'),
    stamped: positions.every(p => p.live), pinned: false,
  };
}

export function buildModel(source) {
  const accounts = source.accounts;
  accounts.forEach(enrich);
  const result = {};
  for (const scope of ['all', ...accounts.map(account=>String(account.number))]) {
    const selected = accounts.filter(account => scope === 'all' || String(account.number) === scope);
    const positions = selected.flatMap(account => account.holdings);
    const total = selected.length === 1 ? selected[0].reportedValue : sum(positions,'cur_value');
    const end = Math.max(...selected.map(account => parseDate(account.meta.date)));
    const rows = [...by(positions,'isin').values()].map(group => aggregate(group,total,end))
      .sort((a,b) => (b.value ?? -1) - (a.value ?? -1));
    const equity = rows.filter(row => row.asset === 'Equity');
    const funds = rows.filter(row => row.asset === 'MF/ETF');
    const crypto = rows.filter(row => row.asset === 'Crypto');
    const valuation = equity.filter(row => row.pe > 0 && row.value > 0);
    const xirrPositions = positions.filter(p => p.xirr != null);
    const tradeXirrPositions = positions.filter(p => p.tradeXirr != null);
    const gain = sum(rows,'gain');
    const cost = rows.some(row=>row.cost!=null) ? sum(rows,'cost') : null;
    const session = rows.some(row=>row.session!=null) ? sum(rows,'session') : null;
    const knownValue = sum(rows,'coveredValue');
    const previous = sum(rows,'previousValue');
    const hhi = sum(rows, row => ((row.weight ?? 0) / 100) ** 2);
    result[scope] = {
      scope, selected, rows, positions, equity, funds, crypto, total, cost, gain:cost==null?null:gain, knownValue,
      summary: selected[0].summary || {}, insights: selected[0].insights || {},
      gainPct: percent(gain,cost), session, previous, sessionPct: percent(session,previous),
      equityValue: sum(equity,'value'), fundValue: sum(funds,'value'),
      quoteValue: sum(rows,'quoteValue'), top10: sum(rows.slice(0,10),'weight'),
      matched: sum(rows,'costCount'), priced: rows.filter(row => row.stamped).length,
      date: selected[0].meta.date, indices: selected.at(-1).indices,
      pe: div(sum(valuation,'value'),sum(valuation,row => row.value / row.pe)),
      peCoverage: percent(sum(valuation,'value'),sum(equity,'value')),
      xirr: selected.length === 1 ? selected[0].portfolioXirr : null,
      xirrCoverage: percent(sum(xirrPositions,'cur_value'),total),
      tradeXirr: annualize(tradeXirrPositions.flatMap(row => row.tradeFlows),end,sum(tradeXirrPositions,'cur_value')),
      tradeXirrCoverage: percent(sum(tradeXirrPositions,'cur_value'),total),
      hhi, effective: div(1,hhi),
      sector: grouped(equity,'sector'), cap: grouped(equity,'mcap_bucket'), fundTypes: grouped(funds,'navType'),
      snapshotTime: selected.map(a => a.meta.live.asof),
    };
  }
  return result;
}

export function grouped(rows,key) {
  return [...by(rows,row => row[key] || 'Unclassified')].map(([name, holdings]) => ({
    name, holdings, value: sum(holdings,'value'), weight: sum(holdings,'weight'),
    session: sum(holdings,'session'), count: holdings.length,
  })).sort((a,b) => b.value - a.value);
}

export function sectorAllocation(model, fundSnapshots) {
  const sectors = new Map();
  const add = (name, value) => sectors.set(name, (sectors.get(name) || 0) + value);
  for (const row of model.equity) {
    if (row.value > 0) add(row.sector || 'Unclassified stocks', row.value);
  }
  let covered = 0, other = 0;
  for (const fund of model.funds) {
    if (!(fund.value > 0)) continue;
    const snapshot = fundSnapshots.get(fund.symbol);
    const weights = Object.entries(snapshot?.sectors || {})
      .filter(([, weight]) => Number.isFinite(weight) && weight > 0 && weight <= 1);
    const reported = sum(weights, ([, weight]) => weight);
    // The provider's sector breakdown describes the equity sleeve.
    const knownEquity = Number.isFinite(snapshot?.stockWeight);
    const equity = knownEquity ? snapshot.stockWeight : 0;
    const sectorValue = fund.value * equity;
    if(knownEquity) other += fund.value - sectorValue;
    for (const [name, weight] of weights) {
      const label = name.replaceAll('_',' ').replace(/\b\w/g, letter=>letter.toUpperCase());
      if(sectorValue>0) add(label, sectorValue * weight / Math.max(1,reported));
    }
    covered += sectorValue * Math.min(1,reported);
  }
  if (other > 0.005) add('Non-stock ETF exposure', other);
  const unclassified = model.fundValue - covered - other;
  if (unclassified > 0.005) add('Unclassified ETF exposure', unclassified);
  const crypto = sum(model.crypto,'value');
  if (crypto > 0) add('Crypto', crypto);
  const merged = new Map();
  for (const [name,value] of sectors) {
    const key = name.toLowerCase();
    const existing = merged.get(key);
    merged.set(key,{name:existing?.name || name,value:(existing?.value || 0)+value});
  }
  return {rows:[...merged.values()].sort((a,b)=>b.value-a.value),covered};
}

export function treemap(items, width, height) {
  const positive = items.filter(item => item.value > 0).slice().sort((a,b) => b.value - a.value);
  const scale = width * height / sum(positive,'value');
  const pending = positive.map(item => ({ item, area: item.value * scale }));
  const bounds = {x:0,y:0,w:width,h:height};
  const rectangles = [];
  const score = (row, edge) => {
    if (!row.length) return Infinity;
    const area = sum(row,'area');
    return Math.max(edge ** 2 * row[0].area / area ** 2, area ** 2 / (edge ** 2 * row.at(-1).area));
  };
  while (pending.length) {
    const row = [pending.shift()];
    const edge = Math.min(bounds.w,bounds.h);
    while (pending.length && score([...row,pending[0]],edge) <= score(row,edge)) row.push(pending.shift());
    const area = sum(row,'area');
    const strip = area / edge;
    const vertical = bounds.w >= bounds.h;
    let offset = 0;
    for (const node of row) {
      const length = node.area / strip;
      rectangles.push({...node.item, x:bounds.x + (vertical ? 0 : offset), y:bounds.y + (vertical ? offset : 0),
        w:vertical ? strip : length, h:vertical ? length : strip});
      offset += length;
    }
    if (vertical) { bounds.x += strip; bounds.w -= strip; }
    else { bounds.y += strip; bounds.h -= strip; }
  }
  return rectangles;
}

export function inRange(points, range) {
  if (!points.length || range === 'All') return points;
  const date = new Date(points.at(-1)[0] + 'T00:00:00Z');
  const months = {'1M':1,'3M':3,'6M':6,'1Y':12,'3Y':36,'5Y':60}[range];
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCDate(Math.min(day,new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate()));
  const boundary = date.toISOString().slice(0,10);
  return points.filter(point => point[0] >= boundary);
}

export function cagrPeriods(points) {
  const rows=points.filter(row=>Number.isFinite(row[2]) && row[2]>0);
  if (rows.length<2) return new Map();
  const first=rows[0], last=rows.at(-1), end=new Date(last[0]+'T00:00:00Z');
  const annualized=row=>{
    const elapsed=(end-Date.parse(row[0]+'T00:00:00Z'))/31557600000;
    const rate=elapsed>0?(Math.pow(last[2]/row[2],1/elapsed)-1)*100:null;
    return Number.isFinite(rate)?rate:null;
  };
  const rates=new Map([['Lifetime',annualized(first)]]);
  for(const years of [1,5,10,15]){
    const year=end.getUTCFullYear()-years, month=end.getUTCMonth();
    const day=Math.min(end.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
    const target=new Date(Date.UTC(year,month,day));
    const row=rows.findLast(candidate=>candidate[0]<=target.toISOString().slice(0,10));
    if(row && target-Date.parse(row[0]+'T00:00:00Z')<=7*86400000) rates.set(years+'Y',annualized(row));
  }
  return rates;
}
