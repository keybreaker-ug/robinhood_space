"use strict";

let D = null, PC = null, HC = null;
let S = { key: "currentValue", dir: -1 };
let performanceRange = "1Y";
let authEpoch = 0, detailEpoch = 0;
let loginRequest, portfolioRequest, detailRequest, sessionTimer;
const q = id => document.getElementById(id);
const finite = value => typeof value === "number" && Number.isFinite(value);
const usd = value => finite(value) ? new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(value) : "—";
const pr = value => finite(value) ? new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
  maximumFractionDigits: value > 0 && value < 1 ? 6 : 2
}).format(value) : "—";
const pc = value => finite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
const holdingQuantity = value => finite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const cl = value => finite(value) ? (value >= 0 ? "pos" : "neg") : "muted";
const clean = value => String(value ?? "").replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function val(holding, metric) {
  if (metric === "value") return holding.currentValue;
  if (metric === "return") return holding.returnPct;
  if (metric === "xirr") return finite(holding.xirr) ? holding.xirr * 100 : null;
  if (metric === "totalReturn") return holding.totalReturnPct ?? null;
  return holding[metric] ?? null;
}

function sortedHoldings(rows, key, direction) {
  return rows.slice().sort((a, b) => {
    const x = key === "return" ? a.returnPct : a[key];
    const y = key === "return" ? b.returnPct : b[key];
    if (!finite(x)) return finite(y) ? 1 : 0;
    if (!finite(y)) return -1;
    return direction * (x - y);
  });
}

function rangeRows(rows, range) {
  const ordered = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!ordered.length || range === "ALL") return ordered;
  const end = new Date(`${ordered.at(-1).date}T12:00:00Z`);
  const months = { "1M": 1, "3M": 3, "1Y": 12 }[range];
  if (!months) return ordered;
  const start = new Date(end), day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return ordered.filter(row => new Date(`${row.date}T12:00:00Z`) >= start);
}

const signedUsd = value => finite(value) ? `${value >= 0 ? "+" : ""}${usd(value)}` : "—";
const shortDate = value => new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const axisDate = (value, days) => days < 150
  ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`))
  : shortDate(value);
const longDate = value => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const compactUsd = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0 }).format(value);

function cagrPeriods(prices) {
  const rows = prices.filter(p => finite(p.close) && p.close > 0).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return [];
  const first = rows[0], last = rows.at(-1);
  const end = new Date(`${last.date}T00:00:00Z`);
  const start = new Date(`${first.date}T00:00:00Z`);
  const annualized = row => {
    const years = (end - new Date(`${row.date}T00:00:00Z`)) / 31557600000;
    return years > 0 ? (Math.pow(last.close / row.close, 1 / years) - 1) * 100 : null;
  };
  const result = [];
  for (const years of [1, 5, 10, 15]) {
    const year = end.getUTCFullYear() - years, month = end.getUTCMonth();
    const day = Math.min(end.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    const target = new Date(Date.UTC(year, month, day));
    if (start > target) continue;
    const row = rows.findLast(p => new Date(`${p.date}T00:00:00Z`) <= target);
    if (row && target - new Date(`${row.date}T00:00:00Z`) <= 7 * 86400000) {
      result.push({ label: `${years}Y CAGR`, value: annualized(row) });
    }
  }
  result.push({ label: "Since inception (annualized)", value: annualized(first) });
  return result;
}

function setTheme(value) {
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem("theme", value); } catch { /* Storage can be disabled. */ }
  if (D) performanceChart();
  if (D && typeof Atlas !== "undefined") Atlas.redrawCharts();
  if (HC) {
    const colors = chartColors();
    HC.data.datasets[0].borderColor = colors.line;
    HC.data.datasets[0].backgroundColor = colors.fill;
    HC.options.scales.x.ticks.color = colors.t;
    HC.options.scales.y.ticks.color = colors.t;
    HC.options.scales.y.grid.color = colors.l;
    HC.update();
  }
}

function theme() {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function menu(event) {
  event.stopPropagation();
  q("menu").classList.toggle("hidden");
  event.currentTarget.setAttribute("aria-expanded", String(!q("menu").classList.contains("hidden")));
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options, credentials: "same-origin", mode: "same-origin", redirect: "error"
  });
  let body;
  try { body = await response.json(); } catch { throw new Error("The server returned an invalid response."); }
  if (!response.ok || body.success === false) {
    const error = new Error(body.message || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function resetData() {
  if (typeof Atlas !== "undefined") Atlas.reset();
  if (typeof Research !== "undefined") Research.reset();
  portfolioRequest?.abort();
  detailRequest?.abort();
  detailEpoch++;
  clearInterval(sessionTimer);
  D = null;
  PC?.destroy(); PC = null;
  HC?.destroy(); HC = null;
  q("holdingsSearch").value = "";
  q("holdingsScroll").scrollTop = 0;
  q("holdingsEmpty").classList.add("hidden");
  for (const id of ["summary", "insights", "insightRiskMethod", "heat", "heatmapUnweightedList", "count", "holdings", "news", "numbers", "analyst", "cagr", "flows", "warnings"]) {
    q(id).replaceChildren();
  }
  q("detail").classList.add("hidden");
  document.title = "Ravenhood Portfolio";
  q("dash").classList.remove("hidden");
  for (const id of ["cashFlowStartMonth", "cashFlowStartYear", "cashFlowEndMonth", "cashFlowEndYear"]) q(id).value = "";
}

function showLogin(message = "") {
  resetData();
  for (const id of ["loading", "waiting", "app"]) q(id).classList.add("hidden");
  q("login").classList.remove("hidden");
  q("loginError").textContent = message;
  q("loginError").classList.toggle("hidden", !message);
  q("signIn").disabled = false;
  q("password").value = "";
}

function startSessionTimer(info) {
  clearInterval(sessionTimer);
  if (!info?.expires_at) return;
  const expires = new Date(info.expires_at).getTime();
  const tick = () => {
    if (Date.now() >= expires) {
      authEpoch++;
      showLogin("Your 45-minute session has expired. Sign in again to continue.");
    }
  };
  sessionTimer = setInterval(tick, 1000);
  tick();
}

async function init() {
  try {
    const result = await api("/check-session");
    if (result.logged_in) {
      q("loading").classList.add("hidden");
      q("app").classList.remove("hidden");
      startSessionTimer(result.session_info);
      await load();
    } else showLogin();
  } catch (error) { showLogin(error.message); }
}

async function loginNow(event) {
  event.preventDefault();
  if (q("signIn").disabled) return;
  const username = q("username").value.trim(), password = q("password").value;
  if (!username || !password) {
    q("loginError").textContent = "Enter your username and password.";
    q("loginError").classList.remove("hidden");
    return;
  }
  const epoch = ++authEpoch;
  loginRequest = new AbortController();
  q("signIn").disabled = true;
  q("password").value = "";
  q("login").classList.add("hidden");
  q("waiting").classList.remove("hidden");
  q("backToLogin").classList.remove("hidden");
  q("waitTitle").textContent = "Waiting for sign-in approval";
  q("waitMessage").textContent = "Approve the request in Robinhood to continue.";
  try {
    const result = await api("/login", { method: "POST", signal: loginRequest.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }) });
    if (epoch !== authEpoch) return;
    q("waitTitle").textContent = "Retrieving your portfolio";
    q("waitMessage").textContent = "Retrieving executed transactions, dividends, and market history.";
    q("backToLogin").classList.add("hidden");
    startSessionTimer(result.session_info);
    await load(true);
  } catch (error) {
    if (epoch === authEpoch && error.name !== "AbortError") showLogin(error.message);
  } finally {
    if (epoch === authEpoch) q("signIn").disabled = false;
  }
}

function backToLogin() {
  authEpoch++;
  loginRequest?.abort();
  showLogin();
}

async function signout(clear) {
  if (clear && !confirm("Remove the saved Robinhood session for this account from this computer?")) return;
  try {
    await api(clear ? "/clear-session" : "/logout", { method: "POST" });
    authEpoch++;
    showLogin();
  } catch (error) {
    if (error.status === 401) { authEpoch++; showLogin(error.message); }
    else setStatus(`Sign-out failed: ${error.message}`);
  }
}

function setStatus(message) {
  q("status").textContent = message;
  q("status").classList.toggle("hidden", !message);
}

async function load(fromLogin = false) {
  if (document.documentElement.dataset.theme !== "dark") setTheme("dark");
  const epoch = authEpoch;
  portfolioRequest?.abort();
  const controller = portfolioRequest = new AbortController();
  q("refresh").disabled = true;
  setStatus("Refreshing holdings, transactions, and market history…");
  try {
    const result = await api("/portfolio", { signal: controller.signal });
    if (epoch !== authEpoch || controller !== portfolioRequest) return;
    D = result.data;
    q("updated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    setStatus("");
    render();
    if (fromLogin) {
      q("waiting").classList.add("hidden");
      q("app").classList.remove("hidden");
    }
    syncDashboardPage();
  } catch (error) {
    if (epoch !== authEpoch || error.name === "AbortError") return;
    if (error.status === 401) { authEpoch++; showLogin(error.message); }
    else {
      // Authentication succeeded even if data retrieval failed. Keep a visible
      // refresh control so the user can retry without re-authenticating.
      if (fromLogin) { q("waiting").classList.add("hidden"); q("app").classList.remove("hidden"); }
      setStatus(error.message);
    }
  } finally {
    if (controller === portfolioRequest) q("refresh").disabled = false;
  }
}

function render() {
  if (!D) return;
  const warnings = D.warnings || [];
  q("warnings").replaceChildren();
  q("warnings").classList.toggle("hidden", warnings.length === 0);
  if (warnings.length) {
    const label = document.createElement("b");
    label.textContent = "Some data is unavailable";
    const list = document.createElement("ul");
    warnings.forEach(message => { const item = document.createElement("li"); item.textContent = message; list.append(item); });
    q("warnings").append(label, list);
  }
  summary(); performanceMetrics(); performanceChart(); insights(); heatmap(); flows(); holdings();
  if (typeof Research !== "undefined") Research.setPortfolio(D);
  if (typeof Atlas !== "undefined") Atlas.setPortfolio(D);
}

function summary() {
  const dividends = D.dividends || {};
  const cash = D.cashSummary || {};
  const rate = finite(cash.apy) ? `${cash.apy.toFixed(2)}% APY` : "Rate unavailable";
  const profit = D.totalProfitLoss;
  let trend = "trend-flat";
  if (finite(profit) && profit !== 0) trend = profit > 0 ? "trend-up" : "trend-down";
  const metrics = [
    ["Current value", usd(D.totalCurrentValue), "wallet", "metric-blue"],
    ["Net invested", usd(D.totalInvestment), "coins", "metric-blue", "Includes purchases funded by reinvested dividends"],
    ["Current P&L", usd(profit), trend, cl(profit), "Current value minus Net invested, plus dividends paid out in cash"],
    ["XIRR return", pc(finite(D.overallXirr) ? D.overallXirr * 100 : null), "percent", cl(D.overallXirr), "Annualized return using dated purchases, sales, and cash dividend payouts"],
    ["Dividends reinvested", usd(dividends.reinvested), "reinvest", cl(dividends.reinvested), "Completed dividend reinvestments"],
    ["Dividends paid out", usd(dividends.paid), "payout", finite(dividends.paid) ? "metric-blue" : "muted", "Dividends retained as cash; excludes reinvested dividends"],
    ["Cash", usd(cash.balance), "cash", finite(cash.balance) ? "metric-blue" : "muted", "Brokerage cash balance reported by Robinhood"],
    ["Interest earned", usd(cash.interestEarned), "interest", cl(cash.interestEarned), "Total interest credited to the brokerage account", rate]
  ];
  q("summary").innerHTML = metricTiles(metrics);
}

function metricTiles(metrics) {
  return metrics.map(([label, value, icon, tone, note, detail]) => `
    <article class="summary-tile"${note ? ` title="${clean(note)}"` : ""}>
      <div class="summary-heading">
        <h2>${clean(label)}</h2>
        <span class="summary-icon ${tone}" aria-hidden="true"><svg class="stroke-icon" focusable="false"><use href="#icon-${icon}"/></svg></span>
      </div>
      <div>
        <p class="summary-value ${tone}">${value}</p>
        ${detail ? `<p class="summary-detail">${clean(detail)}</p>` : ""}
      </div>
    </article>`).join("");
}

function performanceMetrics() {
  const portfolioValue = D.totalCurrentValue;
  const vooValue = D.sp500?.currentValue;
  const vooXirr = D.sp500?.xirr;
  const valueGap = finite(portfolioValue) && finite(vooValue) && vooValue > 0
    ? (portfolioValue - vooValue) / vooValue * 100 : null;

  q("performancePortfolioValue").textContent = usd(portfolioValue);
  q("performanceVooValue").textContent = usd(vooValue);
  q("performanceVooXirr").textContent = pc(finite(vooXirr) ? vooXirr * 100 : null);
  const gap = q("performanceValueGap");
  gap.textContent = pc(valueGap);
  gap.className = cl(valueGap);
}

function chartColors() {
  const style = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  return { t: read("--m"), l: read("--l"), line: read("--chart"),
    fill: read("--chart-fill"), comparison: read("--comparison"), surface: read("--s") };
}

function performanceChart() {
  PC?.destroy(); PC = null;
  if (typeof Chart === "undefined") { setStatus("Charts could not load. Reload the page to try again."); return; }
  const rows = rangeRows(D.historicalData || [], performanceRange), colors = chartColors();
  const spanDays = rows.length > 1 ? (Date.parse(rows.at(-1).date) - Date.parse(rows[0].date)) / 86400000 : 0;
  q("chartPeriod").textContent = rows.length ? `${shortDate(rows[0].date)} — ${shortDate(rows.at(-1).date)}` : "History unavailable";
  const datasets = [{ label: "Portfolio", data: rows.map(r => r.portfolio), borderColor: colors.line,
    backgroundColor: context => {
      const { ctx, chartArea } = context.chart;
      if (!chartArea) return colors.fill;
      const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      gradient.addColorStop(0, colors.fill); gradient.addColorStop(1, "transparent");
      return gradient;
    }, fill: true, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: colors.line,
    pointHoverBorderColor: colors.surface, pointHoverBorderWidth: 3, borderWidth: 2.5, tension: .16, spanGaps: false },
  { label: "VOO", data: rows.map(r => r.sp500), borderColor: colors.comparison,
    borderWidth: 2.2, pointRadius: 0, tension: .16, spanGaps: false }];
  PC = new Chart(q("perf"), {
    type: "line", data: { labels: rows.map(r => r.date), datasets }, options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "#444444", titleColor: "#c7c7c7", bodyColor: "#eeeeee",
        titleFont: { size: 10, weight: "normal" }, bodyFont: { size: 12 }, padding: 13, cornerRadius: 12,
        displayColors: false, callbacks: { title: items => items.length ? longDate(items[0].label) : "",
          label: item => `${item.dataset.label}  ${usd(item.raw)}` } } },
      scales: { x: { border: { display: false }, ticks: { color: colors.t, maxTicksLimit: 4, maxRotation: 0,
          font: { size: 9 }, padding: 10, callback: function(value) { return axisDate(this.getLabelForValue(value), spanDays); } }, grid: { display: false } },
        y: { position: "right", border: { display: false },
          afterDataLimits(scale) {
            scale.min = Math.max(0, scale.min);
            if (scale.max <= 0) scale.max = 1;
          },
          ticks: { color: colors.t, callback: compactUsd, maxTicksLimit: 7,
          font: { size: 11 }, padding: 12 }, grid: { color: colors.l, drawTicks: false, lineWidth: .5 } } }
    }
  });
}

function insightCards(cards) {
  return cards.map(({ title, value, icon, tone = "insight-neutral", status, description, guide }) => `
    <article class="summary-tile insight-tile">
      <div class="summary-heading">
        <h3>${clean(title)}</h3>
        <span class="summary-icon ${tone}" aria-hidden="true"><svg class="stroke-icon" focusable="false"><use href="#icon-${icon}"/></svg></span>
      </div>
      <div>
        <p class="summary-value ${value === "—" ? "muted" : tone}">${clean(value)}</p>
        ${status ? `<p class="insight-status">${clean(status)}</p>` : ""}
        <p class="summary-detail">${clean(description)}</p>
        ${guide ? `<p class="summary-detail insight-guide">${clean(guide)}</p>` : ""}
      </div>
    </article>`).join("");
}

function insights() {
  const i = D.insights || {}, risk = i.risk || {}, voo = risk.benchmark || {};
  const holdings = D.stocks || [];
  const ranked = sortedHoldings(holdings.filter(h => finite(h.totalReturnPct)), "totalReturnPct", -1);
  const top = ranked[0], worst = ranked.at(-1), sector = i.largestStockSector;
  const count = holdings.filter(h => finite(h.currentValue) && h.currentValue > 0).length;
  const holdingCount = count === 1 ? "1 position" : `${count} positions`;
  const format = (value, suffix = "") => finite(value) ? `${value.toFixed(2)}${suffix}` : "—";
  const compare = (value, reference, labels) => {
    if (!finite(value)) return "Unavailable";
    if (!finite(reference)) return "Reference unavailable";
    const difference = Number(value.toFixed(2)) - Number(reference.toFixed(2));
    if (difference < 0) return labels[0];
    if (difference > 0) return labels[2];
    return labels[1];
  };
  const alpha = finite(risk.alpha) ? Number(risk.alpha.toFixed(2)) : null;
  const drawdown = finite(risk.drawdown) ? Math.abs(risk.drawdown) : null;
  const vooDrawdown = finite(voo.drawdown) ? Math.abs(voo.drawdown) : null;
  const betaStatus = finite(risk.beta) && Number(risk.beta.toFixed(2)) <= 0
    ? (Number(risk.beta.toFixed(2)) < 0 ? "Inverse sensitivity" : "No market sensitivity")
    : compare(risk.beta, 1, ["Lower sensitivity", "Market-like sensitivity", "Higher sensitivity"]);
  const benchmarkGuide = (reference, suffix = "") => finite(reference) ? `VOO ${format(reference, suffix)}` : "VOO reference unavailable";

  q("insightRiskMethod").textContent = risk.note || "Risk estimates compare the current stock, ETF, and crypto mix with VOO over shared trading days.";
  q("insights").innerHTML = insightCards([
    { title: "Top performer", value: pc(top?.totalReturnPct), icon: "trend-up", tone: cl(top?.totalReturnPct), status: top?.symbol,
      description: "Highest total return among current holdings with return data." },
    { title: "Worst performer", value: pc(worst?.totalReturnPct), icon: "trend-down", tone: cl(worst?.totalReturnPct), status: worst?.symbol,
      description: "Lowest total return among current holdings with return data." },
    { title: "Largest sector", value: format(sector?.weight, "%"), icon: "wallet", status: sector?.name,
      description: "Share of invested value in the largest identified stock sector. Excludes exposure through ETFs.",
      guide: "Compare with your sector target." },
    { title: "Alpha", value: finite(alpha) ? `${alpha > 0 ? "+" : ""}${format(alpha, " pp")}` : "—", icon: "percent",
      tone: alpha === 0 ? "insight-neutral" : cl(alpha), status: compare(alpha, 0, ["Below model", "In line with model", "Above model"]),
      description: "Annualized return above or below what beta predicts, using VOO.",
      guide: "Below 0 trails · 0 matches · above 0 leads" },
    { title: "Diversification", value: finite(i.diversification) ? i.diversification.toFixed(1) : "—", icon: "coins",
      status: finite(i.diversification) ? `Effective holdings out of ${holdingCount}` : "Unavailable",
      description: "Measures how evenly value is spread across positions. Funds count as one holding each.",
      guide: count > 1 ? `1 = all in one · ${count} = equal weights` : "1 = all value in one holding" },
    { title: "Volatility", value: format(risk.volatility, "%"), icon: "trend-flat",
      status: compare(risk.volatility, voo.volatility, ["Less volatile than VOO", "Matches VOO", "More volatile than VOO"]),
      description: "How much daily returns fluctuate, expressed as an annual rate.",
      guide: `${benchmarkGuide(voo.volatility, "%")} · lower means steadier returns` },
    { title: "Max drawdown", value: format(drawdown, "%"), icon: "trend-down", tone: finite(drawdown) ? "neg" : "muted",
      status: compare(drawdown, vooDrawdown, ["Shallower than VOO", "Matches VOO", "Deeper than VOO"]),
      description: "Largest decline from a prior peak over the period.",
      guide: `${benchmarkGuide(vooDrawdown, "%")} · lower means a smaller decline` },
    { title: "Sharpe ratio", value: format(risk.sharpe), icon: "interest",
      status: compare(risk.sharpe, voo.sharpe, ["Lower than VOO", "Matches VOO", "Higher than VOO"]),
      description: "Excess return per unit of volatility. Above zero beat the assumed cash return.",
      guide: benchmarkGuide(voo.sharpe) },
    { title: "Beta vs S&P 500", value: format(risk.beta), icon: "reinvest", status: betaStatus,
      description: "Sensitivity to S&P 500 moves, measured using VOO.",
      guide: "Below 0 inverse · 0 to <1 lower · 1 matches · >1 higher" },
  ]);
}

function heatmapLayout(items, width, height, weight = item => item.currentValue) {
  const tiles = [];
  function split(rows, x, y, w, h, total) {
    if (rows.length === 1) {
      tiles.push({ item: rows[0], x, y, width: w, height: h });
      return;
    }
    // Split near half the value along the longer edge to keep tiles readable.
    let cut = 1, firstValue = weight(rows[0]);
    while (cut < rows.length - 1 && firstValue + weight(rows[cut]) / 2 < total / 2) {
      firstValue += weight(rows[cut]);
      cut++;
    }
    const share = firstValue / total;
    const first = rows.slice(0, cut), second = rows.slice(cut);
    if (w >= h) {
      const edge = w * share;
      split(first, x, y, edge, h, firstValue);
      split(second, x + edge, y, w - edge, h, total - firstValue);
    } else {
      const edge = h * share;
      split(first, x, y, w, edge, firstValue);
      split(second, x, y + edge, w, h - edge, total - firstValue);
    }
  }
  if (items.length && width > 0 && height > 0) {
    split(items, 0, 0, width, height, items.reduce((total, item) => total + weight(item), 0));
  }
  return tiles;
}

function heatmapSectors(holdings) {
  const sectors = new Map();
  for (const holding of holdings) {
    const name = holding.sector?.trim() || "Uncategorized";
    if (!sectors.has(name)) sectors.set(name, { name, holdings: [], currentValue: 0 });
    const sector = sectors.get(name);
    sector.holdings.push(holding);
    sector.currentValue += holding.currentValue;
  }
  return sortedHoldings([...sectors.values()], "currentValue", -1);
}

const sectorLabelHeight = 24;
const heatmapTileGap = 8;

function readableHeatmapLayout(groups, width, height, grouped) {
  const totalValue = groups.reduce((sum, group) => sum + group.currentValue, 0);
  const count = groups.reduce((sum, group) => sum + group.holdings.length, 0);
  const average = totalValue / count;
  // Reserve more space for small positions only if a tighter layout clips labels.
  for (const reserve of [0, .25, .5, .75, 1]) {
    const weight = (value, items) => value * (1 - reserve) + average * items * reserve;
    const rectangles = grouped
      ? heatmapLayout(groups, width, height, group => weight(group.currentValue, group.holdings.length))
      : [{ item: groups[0], x: 0, y: 0, width, height }];
    const layout = rectangles.map(rect => ({ ...rect, tiles: heatmapLayout(rect.item.holdings,
      rect.width, rect.height - (grouped ? sectorLabelHeight : 0), holding => weight(holding.currentValue, 1)) }));
    if (layout.every(rect => (!grouped || rect.width >= rect.item.name.length * 6 + 8) &&
      rect.tiles.length === rect.item.holdings.length &&
      rect.tiles.every(tile => tile.width >= 88 + heatmapTileGap && tile.height >= 54 + heatmapTileGap))) return layout;
  }
  return null;
}

function positionHeatmapRect(element, rect, width, height, gap = 0) {
  element.style.left = `${(rect.x + gap / 2) / width * 100}%`;
  element.style.top = `${(rect.y + gap / 2) / height * 100}%`;
  element.style.width = `${(rect.width - gap) / width * 100}%`;
  element.style.height = `${(rect.height - gap) / height * 100}%`;
}

function heatmap() {
  if (!D) return;
  const selector = q("metric"), metric = selector.value, filter = q("filter").value;
  const metricLabel = selector.selectedOptions[0].textContent;
  const showWeight = metric === "weight";
  const portfolio = D.totalCurrentValue;
  const hasPortfolioValue = D.valuationComplete !== false && finite(portfolio) && portfolio > 0;
  const weightedColor = showWeight || metric === "value" || metric === "totalReturn";
  const rows = sortedHoldings(D.stocks.filter(h => h.assetType === filter), "currentValue", -1);
  const isSized = holding => finite(holding.currentValue) && holding.currentValue > 0;
  const sized = rows.filter(isSized), unweighted = rows.filter(holding => !isSized(holding));
  const plot = q("heat"), empty = q("heatmapEmpty");
  plot.replaceChildren();
  plot.classList.remove("heatmap-plot-flow");
  plot.style.height = "";
  plot.classList.toggle("hidden", !sized.length);
  q("heatmapFooter").classList.toggle("hidden", !sized.length);
  q("heatmapScale").dataset.mode = weightedColor ? "weight" : "return";
  q("heatmapScaleStart").textContent = weightedColor ? "Smaller weight" : "Loss";
  q("heatmapScaleEnd").textContent = weightedColor ? "Larger weight" : "Gain";
  empty.classList.toggle("hidden", Boolean(rows.length));
  empty.textContent = rows.length ? "" : "No holdings in this category.";
  q("heatmapUnweighted").classList.toggle("hidden", !unweighted.length);

  const makeTile = holding => {
    const value = val(holding, metric);
    const weight = hasPortfolioValue && finite(holding.currentValue) && holding.currentValue >= 0
      ? `${(holding.currentValue / portfolio * 100).toFixed(2)}%` : null;
    const display = showWeight ? weight ?? "—" : metric === "value" ? usd(value) : pc(value);
    const tile = document.createElement("button");
    tile.type = "button";
    tile.innerHTML = `<b>${clean(holding.symbol)}</b><span>${display}</span>`;
    const weightNote = !showWeight && weight ? ` · ${weight} of portfolio` : "";
    tile.title = `${holding.symbol} · ${holding.name} · ${metricLabel} ${display}${weightNote}`;
    tile.setAttribute("aria-label", tile.title);
    tile.addEventListener("click", () => navigateHolding(holding.symbol, holding.assetType));
    return { tile, value };
  };

  q("heatmapUnweightedList").replaceChildren(...unweighted.map(holding => makeTile(holding).tile));
  const width = plot.clientWidth;
  let height = plot.clientHeight;
  if (!sized.length || !width || !height) return;
  const largest = sized[0]?.currentValue;
  const moves = weightedColor ? [] : sized.map(holding => val(holding, metric)).filter(finite);
  const strongest = { gain: Math.max(0, ...moves), loss: -Math.min(0, ...moves) };
  const darkInkAt = { gain: 50, loss: 63, weight: 64 };
  const paintTile = holding => {
    const { tile, value } = makeTile(holding);
    tile.className = "heatmap-tile";
    const magnitude = finite(value) ? Math.abs(value) : 0;
    const returnTone = magnitude ? (value > 0 ? "gain" : "loss") : "neutral";
    tile.dataset.tone = weightedColor ? "weight" : returnTone;
    let strength = 0;
    if (weightedColor) strength = 20 + 80 * holding.currentValue / largest;
    else if (magnitude) strength = 90 * (magnitude / strongest[returnTone]);
    tile.style.setProperty("--heat-strength", `${strength}%`);
    // Switch text color where each theme's blended fill crosses the contrast threshold.
    tile.classList.toggle("heatmap-tile-light-ink", weightedColor && strength < 98);
    tile.classList.toggle("heatmap-tile-dark-ink", strength >= (darkInkAt[tile.dataset.tone] ?? Infinity));
    return tile;
  };

  const grouped = filter === "stock";
  const groups = grouped ? heatmapSectors(sized)
    : [{ holdings: sized, currentValue: sized.reduce((sum, holding) => sum + holding.currentValue, 0) }];
  let layout = readableHeatmapLayout(groups, width, height, grouped);
  if (!layout && width >= 680) {
    // Give the labels more room before switching to rows on a wide screen.
    const tallerHeight = Math.ceil(height * 1.4);
    layout = readableHeatmapLayout(groups, width, tallerHeight, grouped);
    if (layout) {
      height = tallerHeight;
      plot.style.height = `${height}px`;
    }
  }
  plot.classList.toggle("heatmap-plot-flow", !layout);
  q("heatmapSizingNote").classList.toggle("hidden", !layout);
  const plotLabel = grouped ? "Stocks grouped by sector" : "Holdings";
  plot.setAttribute("aria-label", layout ? `${plotLabel} sized by current value` : plotLabel);

  for (const [index, sector] of groups.entries()) {
    const rect = layout?.[index];
    let body = plot;
    if (grouped) {
      const group = document.createElement("div");
      group.className = "heatmap-sector";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", sector.name);
      if (rect) positionHeatmapRect(group, rect, width, height);
      const label = document.createElement("div");
      label.className = "heatmap-sector-label";
      label.textContent = sector.name;
      label.title = sector.name;
      label.style.lineHeight = `${sectorLabelHeight}px`;
      body = document.createElement("div");
      body.className = "heatmap-sector-body";
      group.append(label, body);
      plot.append(group);
    }
    if (!rect) {
      body.append(...sector.holdings.map(paintTile));
      continue;
    }
    for (const placement of rect.tiles) {
      const tile = paintTile(placement.item);
      const symbolSize = Math.min(24, (placement.width - heatmapTileGap - 10) / Math.max(4, placement.item.symbol.length * .68),
        (placement.height - heatmapTileGap) * .34);
      tile.style.setProperty("--heat-symbol-size", `${symbolSize}px`);
      positionHeatmapRect(tile, placement, rect.width, rect.height - (grouped ? sectorLabelHeight : 0), heatmapTileGap);
      body.append(tile);
    }
  }
}

function flows(event) {
  if (!D) return;
  const asOf = (D.asOf || new Date().toISOString()).slice(0, 10);
  const [currentYear, currentMonth] = asOf.split("-");
  const trades = D.cashFlowTransactions;
  const firstTradeYear = Number(trades?.[0]?.date.slice(0, 4)) || Number(currentYear);
  const firstYear = Math.min(Number(currentYear) - 1, firstTradeYear);
  const yearCount = Number(currentYear) - firstYear + 1;
  const start = { year: q("cashFlowStartYear"), month: q("cashFlowStartMonth"), defaultMonth: "01" };
  const end = { year: q("cashFlowEndYear"), month: q("cashFlowEndMonth"), defaultMonth: currentMonth };
  for (const { year, month, defaultMonth } of [start, end]) {
    if (year.options.length !== yearCount || year.options[0]?.value !== currentYear) {
      const previous = year.value;
      year.innerHTML = Array.from({ length: yearCount }, (_, index) => `<option>${Number(currentYear) - index}</option>`).join("");
      year.value = previous;
    }
    if (!month.options.length) {
      const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      month.innerHTML = names.map((name, index) => `<option value="${String(index + 1).padStart(2, "0")}">${name}</option>`).join("");
      month.value = defaultMonth;
    }
    if (!year.value) year.value = currentYear;
    if (!month.value) month.value = defaultMonth;
    if (year.value === currentYear && month.value > currentMonth) month.value = currentMonth;
  }
  const period = ({ year, month }) => `${year.value}-${month.value}`;
  if (period(start) > period(end)) {
    const editedEnd = event?.target === end.year || event?.target === end.month;
    const [source, target] = editedEnd ? [end, start] : [start, end];
    target.year.value = source.year.value;
    target.month.value = source.month.value;
  }
  for (const { year, month } of [start, end]) {
    for (const option of month.options) option.disabled = year.value === currentYear && option.value > currentMonth;
  }
  const from = period(start), to = period(end);
  const available = Array.isArray(trades) && (D.tradeHistoryComplete ?? D.accountingComplete) === true;
  let invested = 0, sold = 0;
  for (const { date, kind, amount } of available ? trades : []) {
    const month = date.slice(0, 7);
    if (month < from || month > to || date > asOf) continue;
    if (kind === "buy") invested -= amount;
    else if (kind === "sell") sold += amount;
  }
  const investedCents = Math.round(invested * 100), soldCents = Math.round(sold * 100);
  const net = investedCents - soldCents;
  const values = [["Invested", investedCents, "pos"], ["Sold", soldCents, "neg"],
    ["Net", net, net ? cl(net) : "muted"]];
  q("flows").innerHTML = values.map(([label, cents, tone]) => `
    <article class="summary-tile cash-metric"><h3>${label}</h3>
      <p class="summary-value ${available ? tone : "muted"}">${usd(available ? cents / 100 : null)}</p>
    </article>`).join("");
}

function sorting(key) {
  S.dir = S.key === key ? -S.dir : -1;
  S.key = key;
  q("holdingsScroll").scrollTop = 0;
  holdings();
}

function sizeHoldingRows() {
  const { rows, style } = q("holdings");
  style.removeProperty("--holdings-row-height");
  let height = 0;
  for (const row of rows) height = Math.max(height, row.getBoundingClientRect().height);
  if (height) style.setProperty("--holdings-row-height", `${Math.ceil(height)}px`);
}

function holdings() {
  if (!D) return;
  const query = q("holdingsSearch").value.trim().toLowerCase();
  const matches = query ? D.stocks.filter(h => h.symbol.toLowerCase().includes(query) ||
    (h.name ?? "").toLowerCase().includes(query)) : D.stocks;
  const total = D.stocks.length;
  q("count").textContent = query ? `${matches.length} of ${total} holdings`
    : `${total} holdings · Select a symbol for a closer look`;
  const empty = q("holdingsEmpty");
  empty.textContent = matches.length ? "" : query ? "No holdings match your search." : "No open positions yet.";
  empty.classList.toggle("hidden", matches.length > 0);
  document.querySelectorAll("[data-sort]").forEach(button => button.closest("th").setAttribute("aria-sort",
    button.dataset.sort === S.key ? S.dir === -1 ? "descending" : "ascending" : "none"));
  const rows = document.createDocumentFragment();
  for (const h of sortedHoldings(matches, S.key, S.dir)) {
    const quantity = holdingQuantity(h.quantity);
    const duration = (h.timeHeld ?? "Unavailable").split(", ").map(part => `<span>${clean(part)}</span>`).join(", ");
    const row = document.createElement("tr");
    row.innerHTML = `<td><button class="table-holding"><b>${clean(h.symbol)}</b><span>${clean(h.name)}</span></button></td>` +
      `<td>${quantity}</td><td>${usd(h.avgCost)}</td><td>${usd(h.currentPrice)}</td><td>${usd(h.costBasis)}</td><td><strong>${usd(h.currentValue)}</strong></td>` +
      `<td class="${cl(h.profitLoss)}"><strong>${usd(h.profitLoss)}</strong></td><td class="${cl(h.totalReturnPct)}"><strong>${pc(h.totalReturnPct)}</strong></td>` +
      `<td class="${cl(h.xirr)}"><strong>${pc(finite(h.xirr) ? h.xirr * 100 : null)}</strong></td><td class="muted"><div class="holding-duration">${duration}</div></td>`;
    row.querySelector("button").addEventListener("click", () => navigateHolding(h.symbol, h.assetType));
    rows.append(row);
  }
  q("holdings").replaceChildren(rows);
  sizeHoldingRows();
}

function navigateHolding(symbol, assetType) {
  location.hash = `#holding/${assetType}/${encodeURIComponent(symbol)}`;
}

function syncHoldingPage() {
  if (!D) return;
  const match = /^#holding\/(stock|etf|crypto)\/([^/]+)$/.exec(location.hash);
  if (match) {
    let symbol;
    try { symbol = decodeURIComponent(match[2]).toUpperCase(); } catch { /* Ignore malformed addresses. */ }
    if (symbol && /^[A-Z0-9.^=-]{1,20}$/.test(symbol)) {
      openHolding(symbol, match[1]);
      return;
    }
  }
  if (!q("detail").classList.contains("hidden")) closeDetail();
}

function syncDashboardPage() {
  syncHoldingPage();
  if (typeof Atlas !== "undefined" && D) Atlas.route();
}

function holdingCards(holding) {
  const h = holding || {};
  const trend = h.profitLoss > 0 ? "trend-up" : h.profitLoss < 0 ? "trend-down" : "trend-flat";
  return metricTiles([
    ["Quantity", holdingQuantity(h.quantity), "coins", "metric-blue"],
    ["Avg buy price", usd(h.avgCost), "wallet", "metric-blue"],
    ["Current price", usd(h.currentPrice), "cash", "metric-blue"],
    ["Cost basis", usd(h.costBasis), "coins", "metric-blue"],
    ["Current value", usd(h.currentValue), "wallet", "metric-blue"],
    ["P&L", usd(h.profitLoss), trend, cl(h.profitLoss)],
    ["Total return", pc(h.totalReturnPct), "percent", cl(h.totalReturnPct)],
    ["XIRR", pc(val(h, "xirr")), "interest", cl(h.xirr)]
  ]);
}

function showAnalyst(analyst, assetType, symbol, currentPrice) {
  const section = q("analyst");
  if (assetType !== "stock") {
    section.textContent = "Analyst consensus and price targets are available for stocks.";
    return;
  }
  if (!analyst) {
    section.textContent = "No current analyst consensus or price target is available.";
    return;
  }
  const sentiment = analyst.sentiment || "—";
  const tone = /buy/i.test(sentiment) ? "pos" : /sell/i.test(sentiment) ? "neg" : "muted";
  const currency = /^[A-Z]{3}$/.test(analyst.currency) ? analyst.currency : "USD";
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const target = analyst.target || {};
  const average = finite(target.mean) ? formatter.format(target.mean) : "—";
  const difference = currency === "USD" && finite(target.mean) && finite(currentPrice) && currentPrice > 0
    ? (target.mean / currentPrice - 1) * 100 : null;
  const ratings = analyst.ratings || {};
  const count = label => finite(ratings[label]) ? ratings[label] : 0;
  const groups = [["Buy", count("Buy") + count("Strong buy")], ["Hold", count("Hold")],
    ["Sell", count("Sell") + count("Strong sell")]];
  const total = groups.reduce((sum, [, size]) => sum + size, 0);
  let bar = "";
  if (total > 0) {
    let x = 0;
    const segments = groups.map(([label, size]) => {
      const width = size / total * 100;
      const segment = `<rect class="analyst-${label.toLowerCase()}" x="${x}" width="${width}" height="10"/>`;
      x += width;
      return segment;
    }).join("");
    const legend = groups.map(([label, size]) => `<li class="analyst-${label.toLowerCase()}">${label} <b>${size}</b></li>`).join("");
    bar = `<svg class="analyst-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">${segments}</svg>
      <ul class="analyst-legend" aria-label="Analyst rating counts">${legend}</ul>`;
  }
  const range = finite(target.low) && finite(target.high)
    ? `${clean(formatter.format(target.low))} to ${clean(formatter.format(target.high))}` : "—";
  const source = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol.replaceAll(".", "-"))}/analysis/`;
  section.innerHTML = `<div class="analyst-stats">
    <div class="analyst-stat"><h3>Consensus</h3><p class="summary-value ${tone}">${clean(sentiment)}</p>${bar}</div>
    <article class="analyst-target">
      <div class="analyst-stat"><h3>Average target price</h3><p class="summary-value ${average === "—" ? "muted" : "metric-blue"}">${clean(average)}</p>
        <p class="small-note"><b class="${difference === 0 ? "muted" : cl(difference)}">${pc(difference)}</b> vs current price</p></div>
      <div class="analyst-stat"><h3>Target range</h3><p class="analyst-target-range">${range}</p></div>
    </article>
  </div>
  <p class="small-note">Source <a href="${source}" target="_blank" rel="noopener noreferrer">Yahoo Finance</a></p>`;
}

async function openHolding(symbol, assetType = "stock") {
  detailRequest?.abort();
  const controller = detailRequest = new AbortController(), epoch = ++detailEpoch, auth = authEpoch;
  const holding = D?.stocks.find(s => s.symbol === symbol && s.assetType === assetType);
  q("dash").classList.add("hidden"); q("detail").classList.remove("hidden"); scrollTo(0, 0);
  q("symbol").textContent = symbol; q("name").textContent = holding?.name || "";
  document.title = `${symbol} · Ravenhood`;
  q("numbers").innerHTML = holdingCards(holding);
  if (typeof Research !== "undefined") Research.setDetail({ ...holding, symbol, assetType });
  for (const id of ["source", "analyst", "news"]) q(id).replaceChildren();
  q("historyFrame").classList.add("hidden");
  cagr([]);
  HC?.destroy(); HC = null;
  q("detailStatus").textContent = "Loading market history…";
  q("detailStatus").classList.remove("hidden");
  try {
    const result = await api(`/holding/${encodeURIComponent(symbol)}?assetType=${encodeURIComponent(assetType)}`, { signal: controller.signal });
    if (epoch !== detailEpoch || auth !== authEpoch) return;
    const data = result.data;
    q("name").textContent = data.company && data.company !== symbol ? data.company : holding?.name || "";
    const prices = data.prices || [];
    q("source").textContent = prices.length ? `From ${longDate(prices[0].date)} · ${data.source}` : "";
    q("detailStatus").textContent = prices.length ? "" : "Price history is unavailable.";
    q("detailStatus").classList.toggle("hidden", prices.length > 0);
    q("historyFrame").classList.toggle("hidden", !prices.length);
    if (prices.length) graph(prices);
    cagr(prices);
    showAnalyst(data.analyst, assetType, symbol, holding?.currentPrice);
    for (const news of (data.news || []).slice(0, 10)) {
      const link = safeLink(news.link);
      if (!link) continue;
      const anchor = document.createElement("a");
      anchor.href = link; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
      const date = Date.parse(news.publishedAt);
      const published = finite(date) ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const byline = [news.publisher, published].filter(Boolean).join(" · ");
      anchor.innerHTML = `<b>${clean(news.title)}</b>${byline ? `<div>${clean(byline)}</div>` : ""}`;
      q("news").append(anchor);
    }
    if (!q("news").children.length) q("news").textContent = (data.warnings || []).some(warning => /news/i.test(warning))
      ? "Recent stories couldn't be loaded. Please try again later." : "No recent news is available.";
  } catch (error) {
    if (epoch !== detailEpoch || auth !== authEpoch || error.name === "AbortError") return;
    if (error.status === 401) { authEpoch++; showLogin(error.message); }
    else {
      q("detailStatus").textContent = error.message;
      showAnalyst(null, assetType, symbol);
      q("news").textContent = "Recent stories couldn't be loaded. Please try again later.";
    }
  }
}

function graph(prices) {
  if (typeof Chart === "undefined") return;
  HC?.destroy(); const colors = chartColors();
  const spanDays = prices.length > 1 ? (Date.parse(prices.at(-1).date) - Date.parse(prices[0].date)) / 86400000 : 0;
  HC = new Chart(q("history"), { type: "line", data: { labels: prices.map(p => p.date),
    datasets: [{ label: "Adjusted price", data: prices.map(p => p.close), borderColor: colors.line, backgroundColor: colors.fill,
      fill: true, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5, tension: .16 }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { displayColors: false, backgroundColor: "#444444", padding: 13,
        cornerRadius: 12, callbacks: { title: items => items.length ? longDate(items[0].label) : "", label: item => pr(item.raw) } } },
      scales: { x: { border: { display: false }, ticks: { color: colors.t, maxTicksLimit: 4, maxRotation: 0, font: { size: 10 },
          callback: function(value) { return axisDate(this.getLabelForValue(value), spanDays); } }, grid: { display: false } },
        y: { position: "right", border: { display: false }, ticks: { color: colors.t, callback: pr, maxTicksLimit: 4, font: { size: 10 }, padding: 10 },
          grid: { color: colors.l, drawTicks: false, lineWidth: .5 } } } } });
}

function cagr(prices) {
  const values = new Map(cagrPeriods(prices).map(row => [row.label, row.value]));
  const labels = ["1Y CAGR", "5Y CAGR", "10Y CAGR", "15Y CAGR", "Lifetime CAGR"];
  q("cagr").innerHTML = labels.map(label => {
    const value = values.get(label === "Lifetime CAGR" ? "Since inception (annualized)" : label);
    return `<article class="summary-tile cagr-card"><h3>${label}</h3><p class="summary-value ${cl(value)}">${pc(value)}</p></article>`;
  }).join("");
}

function closeDetail() {
  detailEpoch++; detailRequest?.abort();
  HC?.destroy(); HC = null;
  document.title = "Ravenhood Portfolio";
  q("detail").classList.add("hidden"); q("dash").classList.remove("hidden"); scrollTo(0, 0);
}

function bootstrap() {
  if (typeof Research !== "undefined") Research.init();
  if (typeof Atlas !== "undefined") Atlas.init();
  let saved = "light";
  try { saved = localStorage.getItem("theme") || saved; } catch { /* Storage can be disabled. */ }
  setTheme(saved === "dark" ? "dark" : "light");
  const actions = { load: () => load(), theme, menu, backToLogin,
    signout: () => signout(false), clearSession: () => signout(true) };
  document.querySelectorAll("[data-action]").forEach(el => el.addEventListener("click", event => actions[el.dataset.action](event)));
  document.querySelectorAll("[data-sort]").forEach(el => el.addEventListener("click", () => sorting(el.dataset.sort)));
  q("holdingsSearch").addEventListener("input", () => {
    q("holdingsScroll").scrollTop = 0;
    holdings();
  });
  document.querySelectorAll("[data-change]").forEach(el => el.addEventListener("change", event => el.dataset.change === "flows" ? flows(event) : heatmap()));
  let heatmapWidth = 0;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === heatmapWidth) return;
    heatmapWidth = entry.contentRect.width;
    heatmap();
  }).observe(q("heat"));
  let holdingsWidth = 0;
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === holdingsWidth) return;
    holdingsWidth = entry.contentRect.width;
    sizeHoldingRows();
  }).observe(q("holdingsScroll"));
  document.querySelectorAll("[data-range]").forEach(el => el.addEventListener("click", () => {
    performanceRange = el.dataset.range;
    document.querySelectorAll("[data-range]").forEach(button => {
      button.classList.toggle("selected", button.dataset.range === performanceRange);
      button.setAttribute("aria-pressed", String(button.dataset.range === performanceRange));
    });
    if (D) performanceChart();
  }));
  window.addEventListener("hashchange", syncDashboardPage);
  q("loginForm").addEventListener("submit", loginNow);
  document.addEventListener("click", () => {
    q("menu").classList.add("hidden");
    document.querySelector('[data-action="menu"]').setAttribute("aria-expanded", "false");
  });
  init();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { usd, pr, pc, cl, clean, val, sortedHoldings, cagrPeriods, safeLink, rangeRows, heatmapLayout, heatmapSectors, readableHeatmapLayout };
} else bootstrap();
