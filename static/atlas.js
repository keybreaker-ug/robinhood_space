"use strict";

const Atlas = (() => {
  const pages = {
    overview: ["Overview", "Portfolio overview", "Your Robinhood portfolio at a glance"],
    history: ["History", "Portfolio history", "Daily portfolio values and the activity behind them"],
    holdings: ["Holdings", "Holdings explorer", "Search and sort your current Robinhood positions"],
    index: ["Holdings index", "Holdings index", "Browse current and previously held securities"],
    heatmaps: ["Heatmaps", "Portfolio heatmaps", "Explore stock, ETF, and crypto positions"],
    allocation: ["Allocation", "Allocation & risk", "Review exposure, concentration, and allocation targets"],
    valuation: ["Valuation", "Equity valuation", "Compare trailing price-to-earnings ratios and data coverage"],
    performance: ["Performance", "Portfolio performance", "Review returns, risk, and the positions that drove results"],
    activity: ["Activity", "Portfolio activity", "Browse the recorded Robinhood ledger and trade cash flows"],
    watchlist: ["Watchlist", "Research watchlist", "Compare owned and watched tickers, screen results, and set alerts"],
    sources: ["Data & methods", "Data & methodology", "Sources, calculation methods, and coverage"]
  };
  const types = ["stock", "etf", "crypto"];
  const eventNames = { buy: "Buy", sell: "Sell", dividend: "Dividend", grant: "Stock reward" };
  const marketSymbols = new Map();
  const pageSize = 25;
  let portfolio, currentPage = "overview", marketChart, historyChart, marketRequest;
  let activityPage = 0, selectedDay, ledger = [], historyByDate = new Map(), eventsByDate = new Map();

  const pct = value => finite(value) ? `${value.toFixed(2)}%` : "—";
  const weight = (value, total) => finite(value) && total > 0 ? 100 * value / total : null;
  const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
  const note = message => `<p class="small-note atlas-note">${clean(message)}</p>`;
  const link = row => `<button type="button" class="atlas-link" data-atlas-ticker="${clean(row.symbol)}" data-atlas-type="${clean(row.assetType)}">${clean(row.symbol)}</button>`;
  const table = (headings, rows) => `<div class="atlas-table" tabindex="0" role="region" aria-label="${clean(headings.join(", "))}"><table>
    <thead><tr>${headings.map(heading => `<th scope="col">${heading}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const shares = (label, percent) => `<div class="atlas-share"><div><span>${clean(label)}</span><b>${pct(percent)}</b></div>
    <progress max="100" value="${Math.max(0, Math.min(percent ?? 0, 100))}" aria-label="${clean(label)}"></progress></div>`;
  const stat = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
  const positionKey = row => `${row.assetType === "crypto" ? "crypto" : "security"}:${row.symbol}`;

  function buildIndex(holdings, events) {
    const positions = new Map();
    for (const event of events) {
      const key = positionKey(event);
      if (!positions.has(key)) positions.set(key, { symbol: event.symbol, name: event.symbol,
        assetType: event.assetType, open: false, activityCount: 0, lastActivity: event.date });
      const row = positions.get(key);
      row.activityCount++;
      if (event.date > row.lastActivity) row.lastActivity = event.date;
    }
    for (const holding of holdings) {
      const key = positionKey(holding);
      positions.set(key, { activityCount: 0, ...positions.get(key), ...holding, open: true });
    }
    return [...positions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  function valuation(rows) {
    const stocks = rows.filter(row => row.assetType === "stock" && row.currentValue > 0);
    const rated = stocks.filter(row => row.trailingPE > 0);
    const covered = sum(rated, "currentValue"), equity = sum(stocks, "currentValue");
    const earnings = rated.reduce((total, row) => total + row.currentValue / row.trailingPE, 0);
    return { equity, covered, pe: earnings > 0 ? covered / earnings : null };
  }

  function renderAllocation() {
    const holdings = portfolio.stocks || [];
    const total = portfolio.totalCurrentValue;
    const cash = portfolio.cashSummary?.balance;
    const groups = [["stock", "Stocks"], ["etf", "ETFs"], ["crypto", "Crypto"]].map(([type, label]) =>
      [label, sum(holdings.filter(row => row.assetType === type), "currentValue")]);
    const combined = finite(cash) && cash >= 0 && finite(total) ? total + cash : null;
    if (combined !== null) groups.push(["Cash", cash]);
    q("atlasMix").innerHTML = groups.map(([label, value]) => shares(label, weight(value, combined ?? total))).join("") +
      note(combined === null ? "Shares of invested value. Cash is shown separately in the overview." : "Shares of portfolio value including cash.");
    const sectors = new Map();
    for (const row of holdings) {
      if (row.assetType === "stock" && finite(row.currentValue)) {
        const sector = row.sector || "Uncategorized";
        sectors.set(sector, (sectors.get(sector) || 0) + row.currentValue);
      }
    }
    const ranked = [...sectors].sort((a, b) => b[1] - a[1]);
    const bars = entries => entries.length ? entries.map(([name, value]) => shares(name, weight(value, total))).join("") : note("No direct stock positions to show.");
    q("atlasSectors").innerHTML = bars(ranked.slice(0, 5));
    q("atlasAllSectors").innerHTML = bars(ranked);
    const sorted = sortedHoldings(holdings, "currentValue", -1).filter(row => row.currentValue > 0);
    const sizes = [...new Set([1, 5, 10, 20].map(count => Math.min(count, sorted.length)))].filter(Boolean);
    q("atlasConcentration").innerHTML = sizes.map(count => shares(`Top ${count}`, weight(sum(sorted.slice(0, count), "currentValue"), total))).join("") ||
      note("No position values available.");
    const caps = { "Mega cap · $200B+": 0, "Large cap · $10B–$200B": 0, "Mid cap · $2B–$10B": 0, "Small and micro cap · below $2B": 0, "Market cap unavailable": 0 };
    const names = Object.keys(caps);
    const stocks = holdings.filter(row => row.assetType === "stock" && finite(row.currentValue));
    for (const row of stocks) {
      const size = row.marketCap;
      const band = !finite(size) || size <= 0 ? 4 : size >= 200e9 ? 0 : size >= 10e9 ? 1 : size >= 2e9 ? 2 : 3;
      caps[names[band]] += row.currentValue;
    }
    const stockTotal = finite(total) ? sum(stocks, "currentValue") : null;
    q("atlasCaps").innerHTML = stockTotal > 0 ? Object.entries(caps).map(([name, value]) => shares(name, weight(value, stockTotal))).join("") :
      note("Direct stock valuation is unavailable.");
  }

  function renderMovers() {
    const rising = q("atlasMoverDirection").value === "up";
    const rows = (portfolio.stocks || []).filter(row => rising ? row.week > 0 : row.week < 0)
      .sort((a, b) => rising ? b.week - a.week : a.week - b.week).slice(0, 5);
    q("atlasMovers").innerHTML = rows.length ? table(["Holding", "Name", "1-week move"], rows.map(row =>
      [link(row), clean(row.name), `<b class="${cl(row.week)}">${pc(row.week)}</b>`])) : note("No holdings match this direction.");
  }

  function renderValuation() {
    const stocks = (portfolio.stocks || []).filter(row => row.assetType === "stock");
    const coverage = valuation(stocks);
    const aggregate = finite(coverage.pe) ? `${coverage.pe.toFixed(2)}×` : "—";
    const band = q("atlasValuationBand").value;
    const selected = stocks.filter(row => {
      const value = row.trailingPE;
      if (band === "all") return true;
      if (!(value > 0)) return band === "missing";
      return band === (value < 15 ? "under" : value < 30 ? "middle" : value < 50 ? "high" : "highest");
    }).sort((a, b) => (b.trailingPE ?? -Infinity) - (a.trailingPE ?? -Infinity));
    q("atlasValuation").innerHTML = `<div class="atlas-stats">
      ${stat("Covered stock P/E", aggregate)}${stat("Stock value covered", pct(weight(coverage.covered, coverage.equity)))}
      </div>` + (selected.length ? table(["Ticker", "Company", "Trailing P/E", "Current value"], selected.map(row => [
        link(row), clean(row.name), finite(row.trailingPE) ? `${row.trailingPE.toFixed(2)}×` : "—", usd(row.currentValue)
      ])) : note("No stocks in this band."));
  }

  function renderIndex() {
    const search = q("atlasIndexSearch").value.trim().toLowerCase();
    const rows = buildIndex(portfolio.stocks || [], ledger).filter(row =>
      `${row.symbol} ${row.name}`.toLowerCase().includes(search));
    q("atlasIndex").innerHTML = rows.length ? table(["Ticker", "Name", "Status", "Activity records", "Last activity"], rows.map(row =>
      [link(row), clean(row.name), row.open ? "Open" : "Historical", row.activityCount, row.lastActivity ? longDate(row.lastActivity) : "—"])) :
      note("No securities match your search.");
  }

  function eventRows(events, includeDate) {
    return events.map(event => {
      const holding = (portfolio.stocks || []).find(row => positionKey(row) === positionKey(event));
      const units = event.quantity ? Math.abs(event.quantity).toLocaleString("en-US", { maximumFractionDigits: 12 }) : "—";
      const action = event.kind === "dividend" && event.reinvested ? "Dividend · reinvested" : eventNames[event.kind];
      return [...(includeDate ? [longDate(event.date)] : []), link(holding || event), action || "—", units,
        event.kind === "grant" ? "—" : signedUsd(event.amount)];
    });
  }

  function renderActivity() {
    const query = q("atlasActivitySearch").value.trim().toUpperCase(), kind = q("atlasActivityKind").value;
    const rows = ledger.filter(row => (!query || row.symbol.includes(query)) && (kind === "all" || row.kind === kind));
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    activityPage = Math.min(activityPage, pageCount - 1);
    const page = rows.slice(activityPage * pageSize, (activityPage + 1) * pageSize);
    q("atlasActivityCount").textContent = `${rows.length} records${portfolio.tradeHistoryComplete === false ? " · trade coverage is incomplete" : ""}`;
    q("atlasActivity").innerHTML = page.length ? table(["Date", "Ticker", "Activity", "Units", "Cash amount"], eventRows(page, true)) :
      note("No activity matches these filters.");
    q("atlasPageNumber").textContent = `Page ${activityPage + 1} of ${pageCount}`;
    q("atlasPrev").disabled = activityPage === 0;
    q("atlasNext").disabled = activityPage >= pageCount - 1;
  }

  function lineChart(canvas, rows, field, label, options = {}) {
    if (typeof Chart === "undefined") return null;
    const colors = chartColors();
    const { onClick, markerData } = options;
    const datasets = [{ label, data: rows.map(row => row[field]), borderColor: colors.line,
      fill: true, backgroundColor: colors.fill, borderWidth: 2, pointRadius: markerData || 0, tension: 0.12 }];
    return new Chart(q(canvas), { type: "line", data: { labels: rows.map(row => row.date), datasets },
      options: { responsive: true, maintainAspectRatio: false, animation: false, onClick,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => longDate(items[0].label),
          label: item => `${label} · ${usd(item.raw)}` } } },
        scales: { x: { ticks: { color: colors.t, maxTicksLimit: 5, maxRotation: 0,
          callback(value) { return shortDate(this.getLabelForValue(value)); } }, grid: { display: false } },
          y: { position: "right", ticks: { color: colors.t, maxTicksLimit: 5, callback: compactUsd }, grid: { color: colors.l } } } }
    });
  }

  async function loadMarket() {
    const symbol = q("atlasMarketSymbol").value;
    marketRequest?.abort();
    if (marketSymbols.has(symbol)) { drawMarket(); return; }
    const controller = marketRequest = new AbortController();
    const account = portfolio;
    marketChart?.destroy(); marketChart = null;
    q("atlasMarketValue").textContent = "Loading market prices…";
    try {
      const response = await api(`/benchmarks/${encodeURIComponent(symbol)}`, { signal: controller.signal });
      if (controller.signal.aborted || !portfolio || portfolio.researchScope !== account.researchScope) return;
      if (response.data.length) marketSymbols.set(symbol, response.data);
      drawMarket();
    } catch (error) {
      if (!controller.signal.aborted) q("atlasMarketValue").textContent = error.message;
    } finally {
      if (marketRequest === controller) marketRequest = null;
    }
  }

  function drawMarket() {
    marketChart?.destroy(); marketChart = null;
    const symbol = q("atlasMarketSymbol").value;
    const rows = marketSymbols.get(symbol);
    if (!rows?.length) { q("atlasMarketValue").textContent = "Benchmark history unavailable."; return; }
    const last = rows.at(-1);
    const change = rows[0].close > 0 ? (last.close / rows[0].close - 1) * 100 : null;
    q("atlasMarketValue").innerHTML = `<b>${usd(last.close)}</b> <span class="${cl(change)}">${pc(change)}</span>
      <small>Since ${longDate(rows[0].date)} · through ${longDate(last.date)}</small>`;
    marketChart = lineChart("atlasMarketChart", rows, "close", symbol);
  }

  function inspectDay(day) {
    if (!day) return;
    selectedDay = q("atlasDay").value = day;
    const row = historyByDate.get(day), events = eventsByDate.get(day) || [];
    q("atlasEventDate").value = events.length ? day : "";
    q("atlasDayDetail").innerHTML = `<div class="atlas-stats">${stat("Portfolio value", usd(row?.portfolio))}
      ${stat("Net invested through this date", usd(row?.netInvestment))}</div>` +
      (events.length ? table(["Ticker", "Activity", "Units", "Cash amount"], eventRows(events, false)) : note("No recorded activity on this date."));
  }

  function drawHistory() {
    historyChart?.destroy(); historyChart = null;
    const rows = rangeRows(portfolio.historicalData || [], q("atlasHistoryRange").value);
    q("atlasHistoryNote").textContent = portfolio.historyNote || "";
    const valid = rows.some(row => finite(row.portfolio));
    q("atlasHistoryStatus").textContent = valid ? "Dots mark dates with recorded activity. Select a point to inspect it." : "Portfolio values are unavailable for this range.";
    q("atlasHistoryChart").parentElement.classList.toggle("hidden", !valid);
    if (valid) {
      historyChart = lineChart("atlasHistoryChart", rows, "portfolio", "Portfolio", {
        markerData: rows.map(row => eventsByDate.has(row.date) ? 3 : 0),
        onClick: (_event, points) => { if (points.length) inspectDay(rows[points[0].index].date); }
      });
    }
    const closeRows = rows.slice(-30);
    q("atlasClosingLedger").innerHTML = closeRows.length ? table(["Date", "Portfolio value", "Daily value change", "Net invested"], closeRows.toReversed().map((row, index) => {
      const previous = rows[rows.length - index - 2];
      const delta = finite(row.portfolio) && finite(previous?.portfolio) ? row.portfolio - previous.portfolio : null;
      return [`<button type="button" class="atlas-link" data-atlas-day="${row.date}">${longDate(row.date)}</button>`,
        usd(row.portfolio), `<span class="${cl(delta)}">${signedUsd(delta)}</span>`, usd(row.netInvestment)];
    })) : note("No daily values available.");
  }

  function route() {
    const hash = location.hash.slice(1);
    const inDetail = !q("detail").classList.contains("hidden");
    const next = Object.hasOwn(pages, hash) ? hash : inDetail ? currentPage : "overview";
    if (next !== currentPage && !inDetail) window.scrollTo({ top: 0, behavior: "instant" });
    currentPage = next;
    q("atlasDetailBack").href = `#${currentPage}`;
    q("atlasBreadcrumb").textContent = inDetail ? "Security research" : pages[next][0];
    q("atlasTitle").textContent = pages[next][1];
    q("atlasSubtitle").textContent = pages[next][2];
    for (const section of document.querySelectorAll("[data-atlas-view]")) {
      section.classList.toggle("hidden", !section.dataset.atlasView.split(" ").includes(next));
    }
    for (const anchor of document.querySelectorAll("[data-atlas-link]")) {
      if (anchor.dataset.atlasLink === next) anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    }
    closeMenu();
    if (inDetail) return;
    const tabs = { allocation: ["check", "preview", "overlap"], performance: ["drivers"], watchlist: ["watch"] };
    if (tabs[next]) Research.setWorkspace(tabs[next]);
    if (next === "overview") {
      if (!marketRequest) loadMarket();
    }
    if (next === "history") drawHistory();
  }

  function setPortfolio(data) {
    portfolio = data;
    ledger = (data.cashFlowTransactions || []).filter(row => types.includes(row.assetType) && row.symbol && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
      .toSorted((a, b) => b.date.localeCompare(a.date) || (b.timestamp || "").localeCompare(a.timestamp || "") ||
        (b.sequence ?? 0) - (a.sequence ?? 0));
    eventsByDate = new Map();
    for (const row of ledger) {
      if (!eventsByDate.has(row.date)) eventsByDate.set(row.date, []);
      eventsByDate.get(row.date).push(row);
    }
    historyByDate = new Map((data.historicalData || []).map(row => [row.date, row]));
    const dateOptions = [new Option("Select an activity date", ""), ...[...eventsByDate].map(([day, rows]) =>
      new Option(`${longDate(day)} · ${rows.length}`, day))];
    q("atlasEventDate").replaceChildren(...dateOptions);
    q("atlasDay").max = data.asOf || "";
    q("atlasDay").min = [data.historicalData?.[0]?.date, ledger.at(-1)?.date].filter(Boolean).sort()[0] || "";
    inspectDay(selectedDay || data.asOf || ledger[0]?.date);
    renderAllocation(); renderMovers(); renderIndex(); renderValuation(); renderActivity();
    q("atlasCoverage").textContent = `${(data.stocks || []).length} current holdings · ${ledger.length} recorded activities${data.asOf ? ` · Portfolio date ${longDate(data.asOf)}` : ""}`;
  }

  function reset() {
    marketRequest?.abort(); marketRequest = null;
    marketChart?.destroy(); marketChart = null;
    historyChart?.destroy(); historyChart = null;
    marketSymbols.clear();
    portfolio = selectedDay = null;
    historyByDate.clear(); eventsByDate.clear();
    ledger = [];
    currentPage = "overview"; activityPage = 0;
    for (const id of ["atlasDay", "atlasActivitySearch", "atlasIndexSearch"]) q(id).value = "";
    for (const id of ["atlasMarketValue", "atlasMix", "atlasMovers", "atlasSectors", "atlasAllSectors", "atlasConcentration",
      "atlasCaps", "atlasDayDetail", "atlasEventDate", "atlasClosingLedger", "atlasIndex", "atlasValuation", "atlasActivity",
      "atlasActivityCount", "atlasCoverage", "atlasHistoryNote", "atlasHistoryStatus", "atlasPageNumber"]) q(id).replaceChildren();
    closeMenu();
  }

  function closeMenu() {
    q("app").classList.remove("atlas-menu-open");
    q("atlasMenu").setAttribute("aria-expanded", "false");
  }

  function search() {
    if (!portfolio) return;
    location.hash = "#holdings";
    // Hash navigation reveals the search field before it receives focus.
    requestAnimationFrame(() => requestAnimationFrame(() => q("holdingsSearch").focus()));
  }

  function init() {
    q("atlasMenu").addEventListener("click", () => {
      const open = q("app").classList.toggle("atlas-menu-open");
      q("atlasMenu").setAttribute("aria-expanded", String(open));
    });
    q("atlasSidebar").addEventListener("click", event => { if (event.target.closest("a")) closeMenu(); });
    q("atlasSearch").addEventListener("click", search);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeMenu();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && portfolio) {
        event.preventDefault(); search();
      }
    });
    q("dash").addEventListener("click", event => {
      const target = event.target.closest("[data-atlas-ticker], [data-atlas-day]");
      if (target?.dataset.atlasTicker) navigateHolding(target.dataset.atlasTicker, target.dataset.atlasType);
      if (target?.dataset.atlasDay) inspectDay(target.dataset.atlasDay);
    });
    q("atlasMarketSymbol").addEventListener("change", loadMarket);
    q("atlasMoverDirection").addEventListener("change", renderMovers);
    q("atlasIndexSearch").addEventListener("input", renderIndex);
    q("atlasValuationBand").addEventListener("change", renderValuation);
    q("atlasDay").addEventListener("change", event => inspectDay(event.target.value));
    q("atlasEventDate").addEventListener("change", event => inspectDay(event.target.value));
    q("atlasHistoryRange").addEventListener("change", drawHistory);
    for (const [id, action] of [["atlasActivitySearch", "input"], ["atlasActivityKind", "change"]]) {
      q(id).addEventListener(action, () => { activityPage = 0; renderActivity(); });
    }
    q("atlasPrev").addEventListener("click", () => { activityPage = Math.max(0, activityPage - 1); renderActivity(); });
    q("atlasNext").addEventListener("click", () => { activityPage++; renderActivity(); });
  }

  function redrawCharts() {
    if (!portfolio) return;
    if (currentPage === "overview" && marketSymbols.has(q("atlasMarketSymbol").value)) drawMarket();
    if (currentPage === "history") drawHistory();
  }

  return { init, reset, route, setPortfolio, redrawCharts, buildIndex, valuation };
})();
