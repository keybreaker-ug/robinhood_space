"use strict";

const Research = (() => {
  const types = ["stock", "etf", "crypto", "cash"];
  const labels = { stock: "Stocks", etf: "ETFs", crypto: "Crypto", cash: "Cash" };
  const policyFields = [...types, "band", "position", "company", "sector"];
  const screenFields = ["pe", "growth", "revisions", "earnings"];
  const isNumber = value => typeof value === "number" && Number.isFinite(value);
  const key = ({ symbol, assetType }) => `${assetType}:${symbol}`;
  const weight = (amount, total) => total > 0 && isNumber(amount) ? 100 * amount / total : null;
  const companyKey = symbol => symbol.toUpperCase().replaceAll(".", "-");
  const sectorKey = sector => (sector || "").toLowerCase().replaceAll("_", " ").trim();
  const sectorName = sector => sector.replace(/\b\w/g, letter => letter.toUpperCase());
  const note = message => `<p class="small-note">${clean(message)}</p>`;
  const pct = value => isNumber(value) ? `${value.toFixed(2)}%` : "—";
  const number = value => isNumber(value) ? value.toFixed(2) : "—";
  const signed = value => isNumber(value) ? `${value < 0 ? "−" : "+"}${usd(Math.abs(value))}` : "—";
  const noPrefs = () => ({ policy: {}, watch: [], screens: [], alerts: [] });
  let portfolio, scope, prefs = noPrefs(), active = "check", preview, scenario, alertTimer;
  let previewRevision = 0;
  let market = new Map(), funds = new Map(), quotes = new Map(), requests = new Map(), alertStatus = new Map();
  let detailAsset, detailLoaded = false;
  let messages = {}, storageFailed = false;

  function exposure(holdings, cash, fundData = new Map()) {
    const groups = { stock: 0, etf: 0, crypto: 0, cash };
    const companies = new Map(), sectors = new Map(), coverage = [];
    let valid = isNumber(cash);
    const addSector = (sector, amount) => sectors.set(sector, (sectors.get(sector) || 0) + amount);
    const addCompany = (symbol, amount, fund) => {
      const id = companyKey(symbol);
      if (!companies.has(id)) companies.set(id, { symbol: id, direct: 0, via: new Map(), total: 0 });
      const company = companies.get(id);
      if (fund) company.via.set(fund, (company.via.get(fund) || 0) + amount);
      else company.direct += amount;
      company.total += amount;
    };
    for (const { symbol, assetType, currentValue, sector } of holdings) {
      if (!isNumber(currentValue) || !["stock", "etf", "crypto"].includes(assetType)) {
        valid = false;
        continue;
      }
      groups[assetType] += currentValue;
      if (assetType === "stock") {
        addCompany(symbol, currentValue);
        if (sector && sector !== "Uncategorized") addSector(sectorKey(sector), currentValue);
      }
      if (assetType === "etf") {
        const fund = fundData.get(symbol);
        let covered = 0, sectorCovered = 0;
        for (const part of fund?.holdings || []) {
          addCompany(part.symbol, currentValue * part.weight, symbol);
          covered += part.weight;
        }
        for (const [name, share] of Object.entries(fund?.sectors || {})) {
          addSector(sectorKey(name), currentValue * share);
          sectorCovered += share;
        }
        coverage.push({ symbol, value: currentValue, covered, sectorCovered, fund });
      }
    }
    const total = valid ? Object.values(groups).reduce((sum, amount) => sum + amount, 0) : null;
    return { total, groups, companies, sectors, coverage };
  }

  function tradePreview(holdings, cash, fundData, asset, action, amount) {
    const before = exposure(holdings, cash, fundData);
    if (!(before.total > 0)) return { error: "Trade Preview needs complete position values and a cash balance." };
    if (!asset || !isNumber(amount) || amount <= 0) return { error: "Choose a ticker and enter a positive amount." };
    const current = holdings.find(holding => key(holding) === key(asset))?.currentValue ?? 0;
    if (action === "sell" && amount > current + 1e-8) return { error: "The sale exceeds the current position value." };
    if (action === "buy" && amount > cash + 1e-8) return { error: "The purchase exceeds available portfolio cash." };
    if (!["buy", "sell"].includes(action)) return { error: "Choose Buy or Sell." };
    const change = action === "buy" ? amount : -amount;
    const next = holdings.filter(holding => key(holding) !== key(asset));
    if (current + change > 1e-8) next.push({ ...asset, currentValue: current + change });
    return { before, after: exposure(next, cash - change, fundData), current, nextValue: current + change, asset };
  }

  function peerMedian(quote, quotes) {
    if (!quote?.industry) return null;
    const peers = [...quotes.values()].filter(peer => peer.assetType === "stock" && peer.symbol !== quote.symbol &&
      peer.industry === quote.industry && peer.forwardPE > 0).map(peer => peer.forwardPE).sort((a, b) => a - b);
    if (!peers.length) return null;
    return (peers[Math.floor((peers.length - 1) / 2)] + peers[Math.floor(peers.length / 2)]) / 2;
  }

  function reviewSignal(asset, model, policy, quote, median) {
    if (!(model.total > 0)) return ["Watch", "Complete portfolio values are required for a review."];
    const breaches = [];
    const check = (amount, limit, label) => {
      const actual = weight(amount, model.total);
      if (isNumber(limit) && actual > limit + 1e-8) breaches.push(`${label} ${pct(actual)} exceeds the ${pct(limit)} cap`);
    };
    const position = asset.currentValue || 0;
    check(position, policy.position, "Position");
    if (position > 0 && asset.assetType === "stock") {
      check(model.companies.get(companyKey(asset.symbol))?.total || 0, policy.company, `${asset.symbol} known exposure`);
      check(model.sectors.get(sectorKey(asset.sector)) || 0, policy.sector, `${asset.sector} known exposure`);
    }
    if (position > 0 && asset.assetType === "etf") {
      for (const company of model.companies.values()) {
        if (company.via.has(asset.symbol)) check(company.total, policy.company, `${company.symbol} known exposure`);
      }
      for (const sector of Object.keys(model.coverage.find(fund => fund.symbol === asset.symbol)?.fund?.sectors || {})) {
        check(model.sectors.get(sectorKey(sector)) || 0, policy.sector, `${sectorName(sectorKey(sector))} known exposure`);
      }
    }
    const target = policy[asset.assetType];
    const drift = isNumber(target) ? weight(model.groups[asset.assetType], model.total) - target : null;
    const band = policy.band ?? 5;
    if (position > 0 && drift > band) breaches.push(`${labels[asset.assetType]} are ${number(drift)} pp above target`);
    if (breaches.length) return ["Review trim", breaches.join(". ") + "."];
    if (drift === null) return ["Watch", "Set an allocation target to evaluate this asset."];
    if (drift >= -band) return ["Watch", "Allocation has no underweight beyond the drift threshold."];
    if (!(isNumber(quote?.sma200) && isNumber(quote.close) && isNumber(quote.relative3m))) {
      return ["Watch", "Allocation is underweight. Trend or benchmark history is unavailable."];
    }
    if (!(quote.close > quote.sma200 && quote.relative3m > 0)) {
      return ["Watch", "Allocation is underweight. The 200-day trend and benchmark comparison do not both support adding."];
    }
    if (asset.assetType === "stock" && !(quote.forwardPE > 0 && median > 0 && quote.forwardPE <= median)) {
      return ["Watch", "Trend supports adding. A forward P/E at or below the tracked peer median is required."];
    }
    return ["Review add", `${labels[asset.assetType]} are ${number(-drift)} pp below target. Price is above its 200-day average and ahead of ${quote.benchmark} over three months.${asset.assetType === "stock" ? " Forward P/E is at or below the tracked peer median." : ""}`];
  }

  function returnDrivers(report, from, to) {
    if (!Array.isArray(report) || !from || !to || from > to) return null;
    const months = report.filter(period => period.month >= from && period.month <= to);
    if (!months.length || months.some(period => period.assets.some(asset => !isNumber(asset.value)))) return null;
    const totals = new Map();
    for (const period of months) {
      for (const asset of period.assets) {
        const previous = totals.get(key(asset));
        totals.set(key(asset), { ...asset, value: (previous?.value || 0) + asset.value });
      }
    }
    return [...totals.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }

  const owned = () => portfolio?.stocks || [];
  const cash = () => portfolio?.cashSummary?.balance ?? null;
  const model = () => exposure(owned(), portfolio?.valuationComplete === false ? null : cash(), funds);
  const heldETFs = () => owned().filter(asset => asset.assetType === "etf");
  const tracked = () => [...new Map([...prefs.watch, ...owned()].map(asset => [key(asset), asset])).values()];
  const selected = (form, name) => form.elements.namedItem(name);
  const read = (form, name) => {
    const field = selected(form, name);
    return field.value !== "" && Number.isFinite(Number(field.value)) ? Number(field.value) : null;
  };
  const signedTone = value => value > 0 ? "pos" : value < 0 ? "neg" : "";
  const card = (label, value, detail = "", tone = "") => `<article class="tools-card"><span>${clean(label)}</span><b class="${tone}">${value}</b>${detail ? `<small>${clean(detail)}</small>` : ""}</article>`;
  const table = (headings, rows) => `<div class="tools-table" tabindex="0" role="region" aria-label="${clean(headings.join(", "))}"><table><thead><tr>${headings.map(name => `<th scope="col">${clean(name)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const tickerLink = asset => `<button type="button" class="tools-link" data-research-ticker="${clean(key(asset))}">${clean(asset.symbol)}</button>`;
  const options = (element, rows) => {
    const previous = element.value;
    element.replaceChildren(...rows.map(([id, label]) => new Option(label, id)));
    if (rows.some(([id]) => id === previous)) element.value = previous;
  };
  function save() {
    if (!scope) return;
    try {
      localStorage.setItem(`ravenhood.research.${scope}`, JSON.stringify(prefs));
      storageFailed = false;
    } catch { storageFailed = true; }
  }

  function renderStatus() {
    const count = [...alertStatus.values()].filter(value => value.met).length;
    q("researchAlertCount").textContent = count ? `${count} price alert${count === 1 ? "" : "s"} met` : "";
    q("researchStatus").textContent = messages[active] || (storageFailed ? "Browser storage is unavailable. Settings apply to this session." : "");
    const disable = (id, busy, empty) => { q(id).disabled = busy || empty; };
    disable("researchCheckLoad", requests.has("market") || requests.has("funds"), tracked().length === 0);
    disable("researchMarketLoad", requests.has("market"), tracked().length === 0);
    disable("researchFundLoad", requests.has("funds"), heldETFs().length === 0);
  }

  function renderCheck() {
    const book = model();
    q("researchAllocation").innerHTML = types.map(type => {
      const actual = weight(book.groups[type], book.total);
      const target = prefs.policy[type];
      const drift = isNumber(actual) && isNumber(target) ? actual - target : null;
      const detail = isNumber(drift) ? `Target ${pct(target)} · ${drift >= 0 ? "+" : ""}${number(drift)} pp` : "Target unset";
      const tone = Math.abs(drift) > (prefs.policy.band ?? 5) ? "tools-watch" : "";
      return card(labels[type], pct(actual), detail, tone);
    }).join("");
    const assets = owned();
    const reviews = assets.map(asset => {
      const quote = market.get(key(asset));
      const [signal, reason] = reviewSignal(asset, book, prefs.policy, quote, peerMedian(quote, market));
      return { asset, signal, reason };
    }).sort((a, b) => ["Review trim", "Review add", "Watch"].indexOf(a.signal) - ["Review trim", "Review add", "Watch"].indexOf(b.signal));
    q("researchChecks").innerHTML = (reviews.length ? table(["Ticker", "Weight", "Review", "Why"], reviews.map(({ asset, signal, reason }) => [
      tickerLink(asset), pct(weight(asset.currentValue, book.total)), signalBadge(signal), clean(reason)
    ])) : note("Positions will appear here once available.")) + note(book.total === null ?
      "Allocation requires complete position values and a reported cash balance." :
      "Weights include cash. Company and sector checks use available look-through data. Allocation drift defaults to 5 percentage points.");
  }

  const signalBadge = signal => `<strong class="${signal === "Review add" ? "pos" : signal === "Review trim" ? "neg" : "tools-watch"}">${signal}</strong>`;
  function renderPreview() {
    const assets = tracked();
    options(q("researchTradeAsset"), assets.map(asset => [key(asset), `${asset.symbol} · ${labels[asset.assetType]}`]));
    const output = q("researchPreviewResult");
    if (!preview) output.innerHTML = note("Preview a cash-funded purchase or sale at today’s marked value.");
    if (preview?.error) output.innerHTML = note(preview.error);
    if (preview && !preview.error) {
      const { before, after, current, nextValue, asset } = preview;
      const rows = [
        [clean(asset.symbol) + " weight", pct(weight(current, before.total)), pct(weight(nextValue, after.total))],
        ["Cash", `${usd(before.groups.cash)} · ${pct(weight(before.groups.cash, before.total))}`, `${usd(after.groups.cash)} · ${pct(weight(after.groups.cash, after.total))}`],
        ["Crypto allocation", pct(weight(before.groups.crypto, before.total)), pct(weight(after.groups.crypto, after.total))]
      ];
      const names = new Set([...before.sectors.keys(), ...after.sectors.keys()]);
      for (const name of names) {
        const previous = before.sectors.get(name) || 0, next = after.sectors.get(name) || 0;
        if (Math.abs(previous - next) > 1e-6) rows.push([clean(sectorName(name)) + " known weight", pct(weight(previous, before.total)), pct(weight(next, after.total))]);
      }
      output.innerHTML = table(["Exposure", "Before", "After"], rows) +
        note(`Hypothetical values exclude fees and taxes. ${rows.length === 3 ? "No change is visible in covered sectors. " : ""}Sector exposure uses available fund data.`);
    }
    const book = model();
    q("researchStressResult").innerHTML = "";
    if (!scenario) return;
    if (!(book.total > 0)) {
      q("researchStressResult").innerHTML = note("The scenario needs complete position values and a cash balance.");
      return;
    }
    const shock = data => types.slice(0, 3).reduce((total, type) => total + data.groups[type] * scenario[type] / 100, 0);
    const impact = shock(book);
    const cards = [card("Current portfolio", signed(impact), `${usd(book.total + impact)} ending value · ${pc(weight(impact, book.total))}`, signedTone(impact))];
    if (preview?.after) {
      const next = shock(preview.after);
      cards.push(card("After previewed trade", signed(next), `${usd(preview.after.total + next)} ending value · ${pc(weight(next, preview.after.total))}`, signedTone(next)));
    }
    q("researchStressResult").innerHTML = `<div class="tools-grid">${cards.join("")}</div>` + note("Each entered move applies to its entire asset class. Cash stays flat.");
  }

  function renderOverlap() {
    const book = model();
    const companyRows = [...book.companies.values()].sort((a, b) => b.total - a.total).map(company => [
      clean(company.symbol), usd(company.direct),
      company.via.size ? [...company.via].map(([fund, amount]) => `${clean(fund)} ${usd(amount)}`).join("<br>") : "—",
      `${usd(company.total)} · ${pct(weight(company.total, book.total))}`
    ]);
    const coverageRows = book.coverage.map(({ symbol, covered, sectorCovered, fund }) => [
      clean(symbol), fund?.holdings?.length ? `${pct(covered * 100)} · ${fund.holdings.length} holdings` : "Unavailable",
      sectorCovered ? pct(sectorCovered * 100) : "Unavailable",
      fund?.retrievedOn ? clean(fund.reportedAsOf ? `As of ${fund.reportedAsOf} · ${fund.source}` : `Retrieved ${fund.retrievedOn} · holdings date unavailable · ${fund.source}`) : "Awaiting fund data"
    ]);
    const sectorRows = [...book.sectors].sort((a, b) => b[1] - a[1]).map(([name, amount]) => [
      clean(sectorName(name)), usd(amount), pct(weight(amount, book.total))
    ]);
    q("researchOverlap").innerHTML = (coverageRows.length ? table(["ETF", "Holdings covered", "Sector coverage", "Data date"], coverageRows) :
      note("No ETFs are currently held.")) + note("Fund reports can cover only part of an ETF. Company totals show direct holdings plus the reported fund exposure.") +
      (companyRows.length ? `<details class="tools-settings" open><summary>Known company exposure</summary>${table(["Company", "Direct", "Through ETFs", "Known total"], companyRows)}</details>` : "") +
      (sectorRows.length ? `<details class="tools-settings"><summary>Known sector exposure</summary>${table(["Sector", "Value", "Portfolio weight"], sectorRows)}</details>` : "");
  }
  const netRevisions = quote => isNumber(quote?.revisionsUp) && isNumber(quote.revisionsDown) ? quote.revisionsUp - quote.revisionsDown : null;
  function renderWatch() {
    const watching = q("researchWatchView").value === "watch";
    const assets = watching ? prefs.watch : owned();
    const form = q("researchFilters");
    const filters = Object.fromEntries(screenFields.map(field => [field, read(form, field)]));
    const aboveAverage = selected(form, "trend").checked;
    const belowPeers = selected(form, "peer").checked;
    const rows = [];
    const book = model();
    for (const asset of assets) {
      const quote = market.get(key(asset));
      const median = peerMedian(quote, market);
      const [signal, reason] = reviewSignal(asset, book, prefs.policy, quote, median);
      const days = quote?.earnings ? Math.ceil((Date.parse(quote.earnings) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000) : null;
      const matches = [
        filters.pe === null || (isNumber(quote?.forwardPE) && quote.forwardPE <= filters.pe),
        filters.growth === null || (isNumber(quote?.growth) && quote.growth * 100 >= filters.growth),
        filters.revisions === null || (isNumber(netRevisions(quote)) && netRevisions(quote) >= filters.revisions),
        filters.earnings === null || (days !== null && days >= 0 && days <= filters.earnings),
        !belowPeers || (quote?.forwardPE > 0 && median > 0 && quote.forwardPE <= median),
        !aboveAverage || (isNumber(quote?.sma200) && quote.close > quote.sma200)
      ];
      if (matches.includes(false)) continue;
      const trend = average => isNumber(quote?.close) && average > 0 ? `<span class="${signedTone(quote.close - average)}">${pc((quote.close / average - 1) * 100)}</span>` : "—";
      let evidence = "Awaiting market data";
      if (quote?.unavailable) evidence = "Market data unavailable";
      else if (quote && asset.assetType === "stock") evidence = [
        `Forward P/E ${number(quote.forwardPE)} · tracked peer median ${number(median)}`,
        `Earnings growth ${pct(isNumber(quote.growth) ? quote.growth * 100 : null)} · Operating margin ${pct(isNumber(quote.margin) ? quote.margin * 100 : null)}`,
        `30-day EPS revisions ${number(netRevisions(quote))} net · Earnings ${clean(quote.earnings || "—")}`
      ].join("<br>");
      else if (quote && asset.assetType === "etf") evidence = `Expense ratio ${pct(quote.expenseRatio)}<br>${clean(quote.category || "Category unavailable")}`;
      else if (quote) evidence = `Weight ${pct(weight(asset.currentValue || 0, book.total))} · 90-day drawdown ${pct(quote.drawdown90)}<br>30-day avg. USD turnover ${usd(quote.turnover30)}`;
      rows.push([
        `${tickerLink(asset)}<br><small>${clean(labels[asset.assetType])}</small>`,
        `${pr(quote?.price ?? quote?.close ?? asset.currentPrice)}<br><small>${clean(quote?.quoteDate || quote?.asOf || "")}</small>`,
        `${trend(quote?.sma50)} / ${trend(quote?.sma200)}`,
        isNumber(quote?.relative3m) ? `<span class="${signedTone(quote.relative3m)}">${number(quote.relative3m)} pp</span> vs ${clean(quote.benchmark)}` : "—",
        evidence, `${signalBadge(signal)}<br><small>${clean(reason)}</small>`,
        ...(watching ? [`<button type="button" class="tools-link" data-research-remove="${clean(key(asset))}">Remove</button>`] : [])
      ]);
    }
    q("researchWatchStatus").textContent = `${rows.length} of ${assets.length} shown. Active filters skip unavailable values.`;
    q("researchWatchRows").innerHTML = rows.length ? table(["Ticker", "Price", "Vs 50 / 200-day avg.", "3-month relative", "Research", "Review", ...(watching ? ["Watchlist"] : [])], rows) :
      note(assets.length ? "No tickers match these filters." : watching ? "Add a ticker to start your watchlist." : "No positions available.");
    options(q("researchSavedScreen"), [["", "Choose a screen"], ...prefs.screens.map(screen => [screen.name, screen.name])]);
    q("researchDeleteScreen").disabled = !q("researchSavedScreen").value;
    options(q("researchAlertAsset"), tracked().map(asset => [key(asset), asset.symbol]));
    renderAlerts();
  }

  function renderAlerts() {
    q("researchAlerts").innerHTML = (prefs.alerts.length ? table(["Ticker", "Condition", "Latest check", "Action"], prefs.alerts.map(alert => {
      const status = alertStatus.get(alert.id);
      return [
        clean(alert.asset.symbol), `${alert.direction === "above" ? "At or above" : "At or below"} ${pr(alert.price)}`,
        status ? `${pr(status.price)} · ${clean(status.date || "latest snapshot")}${status.met ? " · <strong>Condition met</strong>" : ""}` : "Waiting for a public quote",
        `<button class="tools-link" type="button" data-research-alert-remove="${clean(alert.id)}">Remove</button>`
      ];
    })) : note("No price alerts saved.")) + note("Ravenhood checks alerts here every five minutes while signed in. Quote delays depend on the public source.");
  }

  function evaluateAlerts(snapshots = quotes) {
    for (const alert of prefs.alerts) {
      const quote = snapshots.get(key(alert.asset));
      const price = quote?.price ?? quote?.close;
      if (isNumber(price)) alertStatus.set(alert.id, { price, date: quote.quoteDate || quote.asOf, met: alert.direction === "above" ? price >= alert.price : price <= alert.price });
    }
  }

  function renderDrivers() {
    const from = q("researchDriversFrom"), to = q("researchDriversTo");
    const report = portfolio?.monthlyContributions;
    const output = q("researchDrivers");
    const monthLabel = month => new Date(`${month}-01T12:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    const months = (report || []).map(({ month }) => [month, monthLabel(month)]);
    const first = !from.value, last = !to.value;
    options(from, months); options(to, months);
    if (first && months.length) from.value = months.find(([month]) => month.slice(0, 4) === months.at(-1)[0].slice(0, 4))[0];
    if (last && months.length) to.value = months.at(-1)[0];
    const rows = returnDrivers(report, from.value, to.value);
    if (!rows || !rows.length) {
      output.innerHTML = note(from.value && to.value && from.value > to.value ? "Choose a From month on or before the To month." :
        "No complete contribution data for this range. A reconciled ledger and month-end prices are required.");
      return;
    }
    const total = rows.reduce((sum, asset) => sum + asset.value, 0);
    const largest = Math.abs(rows[0].value) || 1;
    const held = new Set(owned().map(key));
    output.innerHTML = `<div class="tools-grid">${card("Total contribution", signed(total), `${monthLabel(from.value)} – ${monthLabel(to.value)}`, signedTone(total))}</div>` +
      table(["Ticker", "Position", "Contribution", "Relative size"], rows.map(asset => [
        tickerLink(asset), held.has(key(asset)) ? "Open" : "Closed", `<strong class="${signedTone(asset.value)}">${signed(asset.value)}</strong>`,
        `<meter class="${signedTone(asset.value)}" min="0" max="1" value="${Math.abs(asset.value) / largest}" aria-label="Contribution magnitude relative to the largest"></meter>`
      ])) + note("Dollar contribution uses month-end values and dated purchases, sales and cash dividends. Reinvested dividends enter as purchases. The current month uses current position values.");
  }

  function render() {
    if (!portfolio) return;
    ({ check: renderCheck, preview: renderPreview, overlap: renderOverlap, watch: renderWatch, drivers: renderDrivers })[active]();
    renderStatus();
  }

  function renderDetail() {
    if (!detailAsset) return;
    const asset = detailAsset, quote = market.get(key(asset)), fund = funds.get(asset.symbol);
    q("holdingWatch").textContent = prefs.watch.some(item => key(item) === key(asset)) ? "Remove from watchlist" : "Add to watchlist";
    q("holdingResearchLoad").disabled = requests.has("market") || (asset.assetType === "etf" && requests.has("funds"));
    if (!detailLoaded) {
      q("holdingResearch").innerHTML = note("Load recent trend, benchmark comparison, and metrics for this asset type.");
      return;
    }
    if (!quote || quote.unavailable) {
      q("holdingResearch").innerHTML = note(q("holdingResearchLoad").disabled ? "Loading market research…" : "Public market research is unavailable.");
      return;
    }
    const vsAverage = average => isNumber(quote.close) && average > 0 ? (quote.close / average - 1) * 100 : null;
    const trend = [50, 200].map(days => {
      const move = vsAverage(quote[`sma${days}`]);
      return card(`Vs ${days}-day average`, pc(move), `Average ${pr(quote[`sma${days}`])}`, signedTone(move));
    });
    trend.push(card(`3-month relative vs ${quote.benchmark}`, isNumber(quote.relative3m) ? `${number(quote.relative3m)} pp` : "—", "", signedTone(quote.relative3m)));
    const book = model();
    const median = peerMedian(quote, market);
    const [signal, reason] = reviewSignal(asset, book, prefs.policy, quote, median);
    trend.push(card("Portfolio review", signalBadge(signal), reason));
    if (asset.assetType === "stock") {
      trend.push(card("Forward P/E", number(quote.forwardPE), `Tracked peer median ${number(median)} · ${quote.industry || "Industry unavailable"}`));
      trend.push(card("Earnings growth", pc(isNumber(quote.growth) ? quote.growth * 100 : null)));
      trend.push(card("30-day EPS revisions", number(netRevisions(quote)), "Net upward revisions for the current quarter"));
      trend.push(card("Next earnings", clean(quote.earnings || "—")));
    }
    if (asset.assetType === "etf") {
      trend.push(card("Expense ratio", pct(quote.expenseRatio), quote.category || ""));
      const parts = fund?.holdings || [];
      const covered = parts.reduce((sum, part) => sum + part.weight, 0);
      const shared = parts.filter(part => {
        const company = book.companies.get(companyKey(part.symbol));
        return company?.direct > 0 || [...(company?.via.keys() || [])].some(other => other !== asset.symbol);
      });
      trend.push(card("Known overlapping companies", fund?.holdings?.length ? String(shared.length) : "—",
        parts.length ? `${pct(covered * 100)} fund holdings covered` : "Fund holdings unavailable"));
    }
    if (asset.assetType === "crypto") {
      trend.push(card("Portfolio weight", pct(weight(asset.currentValue || 0, book.total))));
      trend.push(card("90-day max drawdown", pct(quote.drawdown90), "", signedTone(quote.drawdown90)));
      trend.push(card("30-day avg. USD turnover", usd(quote.turnover30), "Reported daily volume × close"));
    }
    q("holdingResearch").innerHTML = `<div class="tools-grid">${trend.join("")}</div>` + note(`Public market data from Yahoo Finance${quote.asOf ? ` · daily trend through ${quote.asOf}` : ""}.`);
  }

  function setDetail(asset) {
    detailAsset = asset;
    detailLoaded = market.has(key(asset));
    renderDetail();
  }

  async function loadSnapshots(assets, mode, view, refresh = true) {
    if (!portfolio || requests.has(mode)) return;
    const target = mode === "funds" ? funds : mode === "quotes" ? quotes : market;
    const id = mode === "funds" ? asset => asset.symbol : key;
    const items = assets.filter(asset => refresh || !target.has(id(asset)));
    if (!items.length) return;
    const controller = new AbortController();
    requests.set(mode, controller);
    if (view) messages[view] = `Loading ${mode === "funds" ? "ETF holdings" : "market signals"}…`;
    renderStatus();
    let loaded = 0;
    try {
      for (let start = 0; start < items.length; start += 8) {
        const response = await api("/research", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ mode, symbols: items.slice(start, start + 8).map(({ symbol, assetType }) => ({ symbol, assetType })) })
        });
        if (controller.signal.aborted) return;
        for (const snapshot of response.data) target.set(id(snapshot), snapshot);
        if (mode === "quotes") evaluateAlerts();
        loaded += response.data.length;
        if (view) messages[view] = `Loaded ${loaded} of ${items.length} snapshots…`;
        render();
        renderDetail();
      }
      if (view) messages[view] = "";
    } catch (error) {
      if (controller.signal.aborted) return;
      if (view) messages[view] = error.status === 401 ? "Sign in again to refresh research." : "Market data could not be refreshed. Try again.";
    } finally {
      if (requests.get(mode) === controller) {
        requests.delete(mode);
        render();
        renderDetail();
      }
    }
  }

  function selectTab(tab, fetchData = true) {
    active = tab;
    document.querySelectorAll("[data-research-tab]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.researchTab === tab));
      q(`research-${button.dataset.researchTab}`).classList.toggle("hidden", button.dataset.researchTab !== tab);
    });
    render();
    if (fetchData && tab === "overlap") loadSnapshots(heldETFs(), "funds", "overlap", false);
    if (fetchData && tab === "watch") loadSnapshots(tracked(), "market", "watch", false);
  }

  function setWorkspace(tabs) {
    document.querySelectorAll("[data-research-tab]").forEach(button => {
      button.hidden = !tabs.includes(button.dataset.researchTab);
    });
    if (!tabs.includes(active)) selectTab(tabs[0]);
  }

  function syncPolicy() {
    const form = q("researchPolicy");
    for (const field of policyFields) selected(form, field).value = prefs.policy[field] ?? "";
  }

  function setPortfolio(data) {
    if (scope !== data.researchScope) {
      reset();
      scope = data.researchScope;
      try {
        if (scope) {
          const saved = JSON.parse(localStorage.getItem(`ravenhood.research.${scope}`) || "{}");
          prefs = { ...noPrefs(), ...saved };
        }
      } catch { storageFailed = true; }
      syncPolicy();
    }
    portfolio = data;
    q("portfolioTools").classList.remove("hidden");
    preview = null;
    render();
    if (!alertTimer) {
      checkAlerts();
      alertTimer = setInterval(checkAlerts, 300000);
    }
  }

  function reset() {
    if (!q("portfolioTools")) return;
    q("portfolioTools").classList.add("hidden");
    clearInterval(alertTimer);
    alertTimer = null;
    for (const controller of requests.values()) controller.abort();
    requests.clear(); market.clear(); funds.clear(); quotes.clear(); alertStatus.clear();
    portfolio = scope = preview = scenario = detailAsset = null;
    detailLoaded = false;
    q("holdingResearch").replaceChildren();
    prefs = noPrefs();
    messages = {};
    storageFailed = false;
    for (const id of ["researchPolicy", "researchTrade", "researchStress", "researchWatchAdd", "researchFilters", "researchAlert"]) q(id).reset();
    for (const id of ["researchAllocation", "researchChecks", "researchPreviewResult", "researchStressResult",
      "researchOverlap", "researchWatchRows", "researchAlerts", "researchDrivers", "researchTradeAsset",
      "researchAlertAsset", "researchSavedScreen", "researchDriversFrom", "researchDriversTo", "researchStatus",
      "researchAlertCount", "researchPolicyStatus", "researchWatchStatus"]) q(id).replaceChildren();
    q("researchWatchView").value = "owned";
    q("portfolioTools").querySelectorAll("details[open]").forEach(details => { details.open = false; });
    selectTab("check", false);
  }

  function checkAlerts() {
    const assets = [...new Map(prefs.alerts.map(({ asset }) => [key(asset), asset])).values()];
    return loadSnapshots(assets, "quotes");
  }

  function init() {
    if (!q("portfolioTools")) return;
    const on = (id, event, handler) => q(id).addEventListener(event, handler);
    const submit = (id, handler) => on(id, "submit", event => { event.preventDefault(); handler(event.currentTarget); });
    q("portfolioTools").addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      const { researchTab, researchTicker, researchRemove, researchAlertRemove } = button.dataset;
      if (researchTab) selectTab(researchTab);
      if (researchTicker) {
        const [type, symbol] = researchTicker.split(":");
        navigateHolding(symbol, type);
      }
      if (researchRemove) {
        prefs.watch = prefs.watch.filter(asset => key(asset) !== researchRemove);
        save(); render();
      }
      if (researchAlertRemove) {
        prefs.alerts = prefs.alerts.filter(alert => alert.id !== researchAlertRemove);
        alertStatus.delete(researchAlertRemove);
        save(); render();
      }
    });
    submit("researchPolicy", form => {
      const values = Object.fromEntries(policyFields.map(field => [field, read(form, field)]));
      const targets = types.map(type => values[type]);
      if (targets.some(isNumber) && (targets.some(value => value === null) || Math.abs(targets.reduce((sum, value) => sum + value, 0) - 100) > 0.001)) {
        q("researchPolicyStatus").textContent = "Enter all four targets, including zero where needed, so they total 100%.";
        return;
      }
      prefs.policy = values;
      save();
      q("researchPolicyStatus").textContent = storageFailed ? "Applied to this session." : "Saved locally.";
      render();
    });
    on("researchCheckLoad", "click", async () => {
      const account = portfolio?.researchScope;
      await loadSnapshots(heldETFs(), "funds", "check", false);
      if (portfolio && account === portfolio.researchScope) loadSnapshots(tracked(), "market", "check");
    });
    on("researchFundLoad", "click", () => loadSnapshots(heldETFs(), "funds", "overlap"));
    on("researchMarketLoad", "click", () => loadSnapshots(tracked(), "market", "watch"));
    on("holdingWatch", "click", () => {
      if (!detailAsset) return;
      const { symbol, assetType } = detailAsset;
      if (prefs.watch.some(asset => key(asset) === key(detailAsset))) prefs.watch = prefs.watch.filter(asset => key(asset) !== key(detailAsset));
      else if (prefs.watch.length < 100) prefs.watch.push({ symbol, assetType });
      else {
        q("holdingResearch").innerHTML = note("The local watchlist holds up to 100 tickers.");
        return;
      }
      save(); renderDetail(); render();
    });
    on("holdingResearchLoad", "click", async () => {
      if (!detailAsset) return;
      const asset = detailAsset;
      detailLoaded = true;
      const jobs = [loadSnapshots([asset], "market")];
      if (asset.assetType === "etf") jobs.push(loadSnapshots([asset], "funds"));
      renderDetail();
      await Promise.all(jobs);
      renderDetail();
    });
    submit("researchTrade", async () => {
      const revision = ++previewRevision;
      const asset = tracked().find(row => key(row) === q("researchTradeAsset").value);
      const currentPortfolio = portfolio;
      const side = q("researchTradeSide").value, amount = Number(q("researchTradeAmount").value);
      if (asset?.assetType === "etf") await loadSnapshots([...new Map([...heldETFs(), asset].map(item => [item.symbol, item])).values()], "funds", "preview", false);
      if (asset?.assetType === "stock" && !asset.sector) await loadSnapshots([asset], "market", "preview", false);
      if (portfolio !== currentPortfolio || revision !== previewRevision) return;
      const quote = asset && market.get(key(asset));
      preview = tradePreview(owned(), portfolio.valuationComplete === false ? null : cash(), funds,
        asset && { ...asset, sector: asset.sector || quote?.sector }, side, amount);
      render();
    });
    submit("researchStress", form => {
      scenario = Object.fromEntries(types.slice(0, 3).map(type => [type, read(form, type)]));
      render();
    });
    submit("researchWatchAdd", form => {
      const symbol = selected(form, "symbol").value.trim().toUpperCase();
      const asset = { symbol, assetType: selected(form, "assetType").value };
      if (!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(symbol)) {
        messages.watch = "Use a ticker such as AAPL, VOO or BTC.";
        renderStatus();
        return;
      }
      if (!prefs.watch.some(item => key(item) === key(asset))) {
        if (prefs.watch.length >= 100) {
          messages.watch = "The local watchlist holds up to 100 tickers.";
          renderStatus();
          return;
        }
        prefs.watch.push(asset);
        save();
      }
      q("researchWatchView").value = "watch";
      form.reset();
      messages.watch = "";
      render();
      loadSnapshots([asset], "market", "watch", false);
    });
    on("researchWatchView", "change", render);
    on("researchFilters", "input", event => {
      if (event.target.name === "screenName" || event.target.id === "researchSavedScreen") return;
      q("researchSavedScreen").value = "";
      renderWatch();
    });
    submit("researchFilters", form => {
      const name = selected(form, "screenName").value.trim();
      if (!name) {
        messages.watch = "Enter a name to save this screen.";
        renderStatus();
        return;
      }
      const filters = Object.fromEntries(screenFields.map(field => [field, read(form, field)]));
      filters.trend = selected(form, "trend").checked;
      filters.peer = selected(form, "peer").checked;
      prefs.screens = [...prefs.screens.filter(screen => screen.name !== name), { name, filters }];
      save();
      messages.watch = storageFailed ? "Screen saved for this session." : "Screen saved locally.";
      render();
      q("researchSavedScreen").value = name;
      q("researchDeleteScreen").disabled = false;
    });
    on("researchSavedScreen", "change", event => {
      const screen = prefs.screens.find(item => item.name === event.target.value);
      const form = q("researchFilters");
      for (const field of screenFields) selected(form, field).value = screen?.filters[field] ?? "";
      selected(form, "trend").checked = screen?.filters.trend || false;
      selected(form, "peer").checked = screen?.filters.peer || false;
      selected(form, "screenName").value = screen?.name || "";
      render();
    });
    on("researchDeleteScreen", "click", () => {
      prefs.screens = prefs.screens.filter(screen => screen.name !== q("researchSavedScreen").value);
      q("researchFilters").reset();
      messages.watch = "";
      save(); render();
    });
    submit("researchAlert", form => {
      const asset = tracked().find(item => key(item) === q("researchAlertAsset").value);
      const price = read(form, "price");
      if (!asset || !(price > 0)) return;
      prefs.alerts.push({ id: crypto.randomUUID(), asset: { symbol: asset.symbol, assetType: asset.assetType }, direction: selected(form, "direction").value, price });
      save();
      selected(form, "price").value = "";
      evaluateAlerts();
      render();
      checkAlerts();
    });
    on("researchDriversFrom", "change", render);
    on("researchDriversTo", "change", render);
  }

  return { init, setPortfolio, setDetail, setWorkspace, reset, exposure, tradePreview, reviewSignal, returnDrivers, peerMedian };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Research;
