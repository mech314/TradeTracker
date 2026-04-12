import "./style.css";
import {
  extractFillsAndBalances,
  buildRoundTripTrades,
  buildEquitySeries,
} from "./engine.js";
import { computeMetrics, formatPct, formatUsd } from "./metrics.js";
import {
  renderEquityChart,
  renderCumulativeReturnSparkline,
  renderWeekdayChart,
  destroyChart,
} from "./charts.js";
import {
  emptyTradeMeta,
  blobToDataUrl,
} from "./storage.js";

import { isLoggedIn, login, register, logout } from "./auth.js";
import { apiGetAllMeta, apiUpsertMeta, apiDeleteMeta, apiUploadScreenshot, apiUpsertTrades, apiGetTrades, apiDeleteTrade } from "./api.js";

function showAuthScreen() {
  document.querySelector("#app").innerHTML = `
    <div class="min-h-screen flex items-center justify-center bg-surface p-4">
      <div class="w-full max-w-sm rounded-xl border border-slate-800 bg-surface-raised p-6 space-y-4">
        <h1 class="text-xl font-semibold text-white">TradeTracker</h1>
        <p id="auth-msg" class="hidden text-sm text-loss"></p>
        <input id="auth-email" type="email" placeholder="Email"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
        <input id="auth-password" type="password" placeholder="Password"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
        <button id="auth-login-btn"
          class="w-full py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">
          Login
        </button>
        <button id="auth-register-btn"
          class="w-full py-2 rounded-lg bg-surface-overlay text-slate-300 text-sm hover:bg-slate-800 transition-colors">
          Register
        </button>
      </div>
    </div>
  `;

  const msg = () => document.querySelector("#auth-msg");
  const email = () => document.querySelector("#auth-email").value.trim();
  const password = () => document.querySelector("#auth-password").value;

  document.querySelector("#auth-login-btn").addEventListener("click", async () => {
    try {
      await login(email(), password());
      window.location.reload();
    } catch (e) {
      msg().textContent = e.message;
      msg().classList.remove("hidden");
    }
  });

  document.querySelector("#auth-register-btn").addEventListener("click", async () => {
    try {
      await register(email(), password());
      msg().textContent = "Check your email to confirm registration";
      msg().classList.remove("hidden");
      msg().classList.remove("text-loss");
      msg().classList.add("text-gain");
    } catch (e) {
      msg().textContent = e.message;
      msg().classList.remove("hidden");
    }
  });
}

const $ = (sel, el = document) => el.querySelector(sel);

let state = {
  trades: [],
  metrics: null,
  equity: [],
  filesLabel: "No files loaded",
  /** Set when CSVs are loaded: used to refresh the status line after deleting trades. */
  fileLoadInfo: null,
  calendarMonth: new Date(),
  selectedDay: null,
  detailTrade: null,
  tradeMetaById: new Map(),
  screenshotUrls: new Map(),
  page: "dashboard",
};

let metaPopoverHideTimer = null;
let metaPopoverAnchor = null;
let metaPopoverDocumentCloseBound = false;
let modalScreenshotExplicitlyCleared = false;
let tradeMenuTradeId = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** First / last `YYYY-MM-DD` date keys for a calendar month (local `y`, `mo`). */
function monthDateKeyRange(y, mo) {
  const start = `${y}-${pad2(mo + 1)}-01`;
  const last = new Date(y, mo + 1, 0).getDate();
  const end = `${y}-${pad2(mo + 1)}-${pad2(last)}`;
  return { start, end };
}

function equitySeriesForMonth(series, y, mo) {
  const { start, end } = monthDateKeyRange(y, mo);
  return series.filter((p) => p.dateKey >= start && p.dateKey <= end);
}

function tradesClosedInMonth(trades, y, mo) {
  return trades.filter((t) => {
    const parts = t.dateKey.split("-").map(Number);
    const yy = parts[0];
    const mm = parts[1];
    return yy === y && mm - 1 === mo;
  });
}

/**
 * Running sum of round-trip P&amp;L by close date (TraderSage-style cumulative return).
 * - Dashboard (`monthFilter` null): all trades, ordered by calendar day.
 * - Calendar (`{ y, mo }`): only trades closed in that month; line builds through the month.
 */
function cumulativePnlDailySeries(trades, monthFilter) {
  const list = monthFilter
    ? tradesClosedInMonth(trades, monthFilter.y, monthFilter.mo)
    : trades;
  if (!list.length) return [];

  const pnlByDay = new Map();
  for (const t of list) {
    const k = t.dateKey;
    const p = Number.isFinite(t.pnl) ? t.pnl : 0;
    pnlByDay.set(k, (pnlByDay.get(k) || 0) + p);
  }
  const dayKeys = [...pnlByDay.keys()].sort();
  let run = 0;
  return dayKeys.map((dateKey) => {
    run += pnlByDay.get(dateKey);
    return { dateKey, cumulative: run };
  });
}

function toDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday 00:00 local of the week containing `d` (date-only). */
function mondayOnOrBefore(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  x.setDate(x.getDate() - ((dow + 6) % 7));
  return x;
}

/** All Mon–Fri weeks that overlap `[monthFirst, monthLast]`. */
function getWeekRowsForMonth(y, mo) {
  const monthFirst = new Date(y, mo, 1);
  const monthLast = new Date(y, mo, new Date(y, mo + 1, 0).getDate());
  let mon = mondayOnOrBefore(monthFirst);
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const fri = addDays(mon, 4);
    if (mon > monthLast) break;
    if (fri >= monthFirst) rows.push({ monday: new Date(mon) });
    mon = addDays(mon, 7);
    if (mon > addDays(monthLast, 6)) break;
  }
  return rows;
}

function dayStats(trades, dateKey) {
  const dayTrades = trades.filter((t) => t.dateKey === dateKey);
  const pnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = dayTrades.filter((t) => t.win).length;
  const losses = dayTrades.length - wins;
  return { pnl, wins, losses, count: dayTrades.length };
}

function weekStats(trades, dateKeys) {
  const weekTrades = trades.filter((t) => dateKeys.includes(t.dateKey));
  const pnl = weekTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = weekTrades.filter((t) => t.win).length;
  const losses = weekTrades.length - wins;
  const grossProfit = weekTrades
    .filter((t) => t.pnl > 0)
    .reduce((s, t) => s + t.pnl, 0);
  const grossLossAbs = Math.abs(
    weekTrades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0),
  );
  let profitFactor = null;
  if (grossLossAbs > 0) profitFactor = grossProfit / grossLossAbs;
  else if (grossProfit > 0) profitFactor = Infinity;
  else profitFactor = Infinity;

  const winRate = weekTrades.length ? wins / weekTrades.length : null;
  return { pnl, wins, losses, profitFactor, winRate, tradeCount: weekTrades.length };
}

function formatCompactUsd(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

/** P&amp;L ÷ total risk when total risk &gt; 0; otherwise null. */
function tradeRiskRewardMultiple(t, meta) {
  const rps = meta.riskPerShare;
  const rpsNum =
    rps != null && rps !== "" && Number.isFinite(Number(rps))
      ? Number(rps)
      : null;
  const totalRisk =
    rpsNum != null && t.maxShares > 0 ? rpsNum * t.maxShares : null;
  if (totalRisk == null || totalRisk <= 0 || !Number.isFinite(t.pnl)) {
    return null;
  }
  return t.pnl / totalRisk;
}

/** Inner HTML for R:R cell in the trade table. */
function riskRewardCellInnerHtml(t, meta) {
  const rr = tradeRiskRewardMultiple(t, meta);
  if (rr == null || !Number.isFinite(rr)) {
    return `<span class="text-slate-600">—</span>`;
  }
  const cls =
    rr > 0 ? "text-gain" : rr < 0 ? "text-loss" : "text-slate-400";
  return `<span class="font-mono ${cls}">${rr.toFixed(2)}R</span>`;
}

/** Mean R-multiple over trades with total risk set (same basis as the R:R column). */
function averageRiskRewardForTrades(trades) {
  const values = [];
  for (const t of trades) {
    const rr = tradeRiskRewardMultiple(t, tradeMeta(t.id));
    if (rr != null && Number.isFinite(rr)) values.push(rr);
  }
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Shared risk/sh, total risk markup, and input value for table + mobile cards. */
function tradeRiskDisplayParts(t, meta) {
  const rps = meta.riskPerShare;
  const rpsNum =
    rps != null && rps !== "" && Number.isFinite(Number(rps))
      ? Number(rps)
      : null;
  const totalRisk =
    rpsNum != null && t.maxShares > 0 ? rpsNum * t.maxShares : null;
  const riskVal = rpsNum != null ? String(rpsNum) : "";
  const totalInner =
    totalRisk != null
      ? `<span class="font-mono ${totalRisk >= 0 ? "text-slate-300" : "text-loss"}">${formatUsd(totalRisk)}</span>`
      : `<span class="text-slate-600">—</span>`;
  return { rpsNum, riskVal, totalInner };
}

function tradeRowHtml(t) {
  const meta = tradeMeta(t.id);
  const hasNote = (meta.notes || "").trim().length > 0;
  const hasShot =
    state.screenshotUrls.has(t.id) || hasScreenshotStored(meta);
  const { riskVal, totalInner } = tradeRiskDisplayParts(t, meta);
  const noteClass = hasNote
    ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/40"
    : "bg-slate-800 text-slate-600";
  const shotClass = hasShot
    ? "bg-sky-500/25 text-sky-200 ring-1 ring-sky-500/40"
    : "bg-slate-800 text-slate-600";
  const shareTitle = `Peak shares: ${t.maxShares} · Round-turn volume: ${t.shareTurnover}`;
  return `
    <tr class="hover:bg-surface-overlay/60 cursor-pointer transition-colors trade-row group" data-id="${escapeAttr(t.id)}">
      <td class="px-3 py-2 font-mono text-slate-400">${t.dateKey}</td>
      <td class="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">${formatCloseTime(t.closeTs)}</td>
      <td class="px-3 py-2 font-medium text-white">${t.symbol}</td>
      <td class="px-3 py-2 text-slate-400">${t.openSide}</td>
      <td class="px-3 py-2 text-right font-mono text-slate-300" title="${escapeAttr(shareTitle)}">${t.maxShares}</td>
      <td class="px-3 py-2 text-right no-row-open">
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="—" class="risk-input w-[4.5rem] min-h-[44px] sm:min-h-0 px-2 py-2 sm:py-1 rounded-md bg-surface border border-slate-700 text-slate-200 text-right font-mono text-xs focus:outline-none focus:ring-1 focus:ring-accent" data-trade-id="${escapeAttr(t.id)}" value="${escapeAttr(riskVal)}" />
      </td>
      <td class="px-3 py-2 text-right font-mono text-sm" data-risk-total="${escapeAttr(t.id)}">${totalInner}</td>
      <td class="px-3 py-2 text-right font-mono text-sm" data-rr="${escapeAttr(t.id)}">${riskRewardCellInnerHtml(t, meta)}</td>
      <td class="px-3 py-2 text-right font-mono ${t.pnl > 0 ? "text-gain" : "text-loss"}">${formatUsd(t.pnl)}</td>
      <td class="px-3 py-2">${t.win ? '<span class="text-gain">Win</span>' : '<span class="text-loss">Loss</span>'}</td>
      <td class="px-2 py-2 no-row-open text-center">
        <button type="button" class="meta-preview-trigger inline-flex items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-2 py-2 sm:px-1 sm:py-1 rounded-lg hover:bg-slate-800/80 transition-colors active:bg-slate-800" data-trade-id="${escapeAttr(t.id)}" aria-label="Preview notes and screenshot">
          <span class="inline-flex h-7 w-7 sm:h-6 sm:min-w-[1.5rem] items-center justify-center rounded text-[10px] font-semibold ${noteClass}">N</span>
          <span class="inline-flex h-7 w-7 sm:h-6 sm:min-w-[1.5rem] items-center justify-center rounded text-[10px] font-semibold ${shotClass}">S</span>
        </button>
      </td>
      <td class="px-1 py-2 no-row-open text-right w-10">
        <button type="button" class="trade-menu-btn min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800/80 transition-colors" data-trade-id="${escapeAttr(t.id)}" aria-label="Trade options" aria-haspopup="menu" aria-expanded="false">⋮</button>
      </td>
    </tr>`;
}

function tradeMobileCardHtml(t) {
  const meta = tradeMeta(t.id);
  const hasNote = (meta.notes || "").trim().length > 0;
  const hasShot =
    state.screenshotUrls.has(t.id) || hasScreenshotStored(meta);
  const { riskVal, totalInner } = tradeRiskDisplayParts(t, meta);
  const noteClass = hasNote
    ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/40"
    : "bg-slate-800 text-slate-600";
  const shotClass = hasShot
    ? "bg-sky-500/25 text-sky-200 ring-1 ring-sky-500/40"
    : "bg-slate-800 text-slate-600";
  const pnlCls = t.pnl > 0 ? "text-gain" : "text-loss";
  return `
    <article class="trade-mobile-card trade-row rounded-xl border border-slate-800 bg-surface-overlay/50 p-3 cursor-pointer" data-id="${escapeAttr(t.id)}">
      <div class="flex justify-between gap-3 items-start">
        <div class="min-w-0">
          <p class="text-base font-semibold text-white truncate">${escapeHtml(t.symbol)}</p>
          <p class="text-xs text-slate-500 font-mono mt-0.5">${t.dateKey} · ${formatCloseTime(t.closeTs)}</p>
          <p class="text-xs text-slate-400 mt-1">${escapeHtml(t.openSide)} · <span class="font-mono text-slate-300">${t.maxShares}</span> sh</p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-lg font-mono font-semibold ${pnlCls}">${formatUsd(t.pnl)}</p>
          <p class="text-xs mt-0.5">${t.win ? '<span class="text-gain">Win</span>' : '<span class="text-loss">Loss</span>'}</p>
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2 no-row-open">
        <span class="text-xs text-slate-500 shrink-0">Risk/sh</span>
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="—" class="risk-input flex-1 min-w-[5rem] max-w-[9rem] min-h-[44px] px-3 rounded-lg bg-surface border border-slate-700 text-slate-200 text-right font-mono text-sm focus:outline-none focus:ring-1 focus:ring-accent" data-trade-id="${escapeAttr(t.id)}" value="${escapeAttr(riskVal)}" />
        <span class="text-xs text-slate-500 shrink-0">Total</span>
        <span class="text-sm font-mono text-right min-w-[4.5rem]" data-risk-total="${escapeAttr(t.id)}">${totalInner}</span>
        <span class="text-xs text-slate-500 shrink-0">R:R</span>
        <span class="text-sm font-mono min-w-[3.5rem] text-right" data-rr="${escapeAttr(t.id)}">${riskRewardCellInnerHtml(t, meta)}</span>
      </div>
      <div class="mt-3 flex items-center justify-between no-row-open">
        <button type="button" class="meta-preview-trigger inline-flex items-center gap-2 min-h-[44px] px-3 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800/80 active:bg-slate-800 transition-colors" data-trade-id="${escapeAttr(t.id)}" aria-label="Notes and screenshot">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded text-[10px] font-semibold ${noteClass}">N</span>
          <span class="inline-flex h-8 w-8 items-center justify-center rounded text-[10px] font-semibold ${shotClass}">S</span>
          <span class="text-xs text-slate-500">Preview</span>
        </button>
        <button type="button" class="trade-menu-btn min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800/80 border border-transparent" data-trade-id="${escapeAttr(t.id)}" aria-label="Trade options" aria-haspopup="menu" aria-expanded="false">⋮</button>
      </div>
    </article>`;
}

async function persistRiskFromInput(tradeId, inputEl) {
  const raw = inputEl.value.trim();
  let riskPerShare = null;
  if (raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      inputEl.classList.add("ring-1", "ring-loss");
      return;
    }
    riskPerShare = parsed;
  }
  inputEl.classList.remove("ring-1", "ring-loss");
  let merged;
  try {
    merged = await apiUpsertMeta({
      id: tradeId,
      notes: state.tradeMetaById.get(tradeId)?.notes ?? null,
      riskPerShare,
      screenshotUrl: state.tradeMetaById.get(tradeId)?.screenshotUrl ?? null,
    });
    const existing = state.tradeMetaById.get(tradeId) || emptyTradeMeta(tradeId);
    merged = { ...existing, riskPerShare };
  } catch (err) {
    console.error(err);
    alert(err?.message ? `Save failed: ${err.message}` : "Save failed.");
    return;
  }
  state.tradeMetaById.set(tradeId, merged);
  const t = state.trades.find((x) => x.id === tradeId);
  const riskEls = document.querySelectorAll(
    `[data-risk-total="${CSS.escape(tradeId)}"]`,
  );
  if (t) {
    const tr =
      riskPerShare != null && t.maxShares > 0 ? riskPerShare * t.maxShares : null;
    const inner =
      tr != null
        ? `<span class="font-mono ${tr >= 0 ? "text-slate-300" : "text-loss"}">${formatUsd(tr)}</span>`
        : `<span class="text-slate-600">—</span>`;
    riskEls.forEach((cell) => {
      cell.innerHTML = inner;
    });
  }
  const rrEls = document.querySelectorAll(`[data-rr="${CSS.escape(tradeId)}"]`);
  if (t) {
    const rrHtml = riskRewardCellInnerHtml(t, merged);
    rrEls.forEach((cell) => {
      cell.innerHTML = rrHtml;
    });
  }
  paintCharts();
}

function parseFiles(files) {
  return Promise.all(
    [...files].map((f) => f.text().then((t) => ({ name: f.name, text: t }))),
  );
}

function mergeExtracts(parts) {
  const fills = [];
  const balancePoints = [];
  for (const { text } of parts) {
    const x = extractFillsAndBalances(text);
    fills.push(...x.fills);
    balancePoints.push(...x.balancePoints);
  }
  fills.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
  balancePoints.sort((a, b) => a.ts - b.ts);
  return { fills, balancePoints };
}

function render() {
  closeMobileNav();
  const root = $("#app");
  const m = state.metrics;
  const trades = state.trades;
  const dayFilter = state.selectedDay;

  const cal = state.calendarMonth;
  let calendarTableTrades = tradesClosedInMonth(
    trades,
    cal.getFullYear(),
    cal.getMonth(),
  );
  if (dayFilter != null) {
    calendarTableTrades = calendarTableTrades
      .filter((t) => t.dateKey === dayFilter)
      .sort((a, b) => a.closeTs - b.closeTs);
  } else {
    calendarTableTrades = [...calendarTableTrades].sort(
      (a, b) => b.closeTs - a.closeTs,
    );
  }
  const calendarTableCaption = dayFilter
    ? `Day: ${dayFilter} · sorted by close time`
    : cal.toLocaleString(undefined, { month: "long", year: "numeric" });

  const dashboardStatsHtml = `
    <section class="grid sm:grid-cols-2 lg:grid-cols-5 gap-4" id="stat-cards">
      ${statCard("Counted trades", m ? String(m.tradeCount) : "—")}
      ${statCard("Win rate", m ? formatPct(m.winRate) : "—", "Breakeven counts as loss")}
      ${statCard("Profit factor", m ? formatPF(m.profitFactor) : "—")}
      ${statCard("Avg return per dollar", m ? formatPct(m.avgReturnPerDollar) : "—", "Mean of each trade’s P&amp;L ÷ (½ × sum of |fill amounts|)")}
      ${statCard("Total P&amp;L", m ? formatUsd(m.totalPnl) : "—")}
    </section>`;

  const calendarHtml = `
    <section class="rounded-xl border border-slate-800 bg-surface-raised p-4">
          <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
            <h2 class="text-sm font-medium text-slate-400">Calendar</h2>
            <div class="flex items-center gap-1 sm:gap-2 flex-wrap justify-end">
              <button type="button" id="cal-prev" class="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-3 py-2 sm:py-1.5 rounded-lg bg-surface-overlay text-sm text-slate-300 hover:bg-slate-800 active:bg-slate-800">←</button>
              <span class="text-sm text-slate-300 min-w-[8rem] sm:min-w-[9rem] text-center" id="cal-label"></span>
              <button type="button" id="cal-next" class="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-3 py-2 sm:py-1.5 rounded-lg bg-surface-overlay text-sm text-slate-300 hover:bg-slate-800 active:bg-slate-800">→</button>
              ${state.selectedDay ? `<button type="button" id="cal-clear" class="min-h-[44px] px-3 text-xs text-accent sm:ml-2 rounded-lg hover:bg-slate-800/80">Clear day</button>` : ""}
            </div>
          </div>
          <div class="overflow-x-auto -mx-1 px-1 touch-pan-x overscroll-x-contain">
            <div id="calendar-grid" class="space-y-2 text-sm min-w-[640px]"></div>
          </div>
        </section>

        <section class="rounded-xl border border-slate-800 bg-surface-raised overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-800 flex flex-wrap justify-between gap-2">
            <h2 class="text-sm font-medium text-slate-400">Trades</h2>
            <span class="text-xs text-slate-500">${calendarTableCaption} · ${calendarTableTrades.length} shown</span>
          </div>
          <div class="hidden md:block overflow-x-auto touch-pan-x">
            <table class="w-full text-sm min-w-[1000px]">
              <thead class="text-left text-slate-500 border-b border-slate-800">
                <tr>
                  <th class="px-3 py-2 font-medium">Date</th>
                  <th class="px-3 py-2 font-medium">Closed</th>
                  <th class="px-3 py-2 font-medium">Symbol</th>
                  <th class="px-3 py-2 font-medium">Side</th>
                  <th class="px-3 py-2 font-medium text-right cursor-help" title="Peak shares held during the trade. Tooltip on cell shows round-turn share volume.">Shares</th>
                  <th class="px-3 py-2 font-medium text-right cursor-help" title="Dollar risk per share (e.g. distance to stop). Total risk = this × peak shares.">Risk/sh $</th>
                  <th class="px-3 py-2 font-medium text-right cursor-help" title="Risk/sh × peak shares, when risk/sh is set.">Total risk</th>
                  <th class="px-3 py-2 font-medium text-right cursor-help" title="P&amp;L divided by total risk (1R = amount risked). Shown only when total risk is set.">R:R</th>
                  <th class="px-3 py-2 font-medium text-right">P&amp;L</th>
                  <th class="px-3 py-2 font-medium">Result</th>
                  <th class="px-3 py-2 font-medium text-center cursor-help" title="Hover for note and screenshot preview.">Notes</th>
                  <th class="px-2 py-2 font-medium text-right w-10"><span class="sr-only">Options</span></th>
                </tr>
              </thead>
              <tbody id="trades-tbody" class="divide-y divide-slate-800/80">
                ${calendarTableTrades.map((t) => tradeRowHtml(t)).join("")}
              </tbody>
            </table>
          </div>
          <div id="trades-mobile-cards" class="md:hidden p-3 space-y-3 bg-surface-raised">
            ${calendarTableTrades.map((t) => tradeMobileCardHtml(t)).join("")}
          </div>
        </section>`;

  const navBtn = (page, label) => {
    const active = state.page === page;
    return `<button type="button" data-nav-page="${page}" class="w-full text-left px-3 py-2.5 text-sm rounded-lg transition-colors ${
      active
        ? "bg-slate-800 text-white border-l-2 border-accent pl-[10px]"
        : "text-slate-300 hover:bg-slate-800/90"
    }">${label}</button>`;
  };
  root.innerHTML = `
    <div class="min-h-screen flex">
    <aside class="hidden lg:flex w-56 lg:w-64 shrink-0 min-h-screen self-stretch flex-col bg-slate-900 border-r border-slate-700 p-3 lg:p-4 text-sm text-slate-300">
      ${navBtn("dashboard", "Dashboard")}
      ${navBtn("calendar", "Calendar")}
    </aside>
    <div class="flex-1 min-w-0 flex flex-col min-h-screen">
    <header class="border-b border-slate-800/80 bg-surface-raised/50 backdrop-blur-sm sticky top-0 z-30 pt-[env(safe-area-inset-top,0px)]">
      <div class="max-w-7xl mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div class="flex items-start gap-2 min-w-0 flex-1">
          <button type="button" id="mobile-nav-open" class="flex lg:hidden shrink-0 mt-0.5 min-h-[44px] items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3 text-accent hover:bg-accent/25 active:bg-accent/20 transition-colors" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-nav-panel">
            <svg class="w-5 h-5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
            <span class="text-xs font-semibold tracking-wide">Menu</span>
          </button>
          <div class="min-w-0">
            <h1 class="text-lg sm:text-xl font-semibold tracking-tight text-white">TradeTracker</h1>
            <p class="text-xs sm:text-sm text-slate-500 mt-0.5 leading-snug">Same-day round trips · long &amp; short · no fees in P&amp;L</p>
          </div>
        </div>
        <label class="cursor-pointer inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-lg bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors border border-accent/30 shrink-0">
          <input type="file" accept=".csv,text/csv" multiple class="hidden" id="file-input" />
          Load CSV
        </label>
        <button type="button" id="logout-btn" class="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-lg bg-surface-overlay text-slate-400 text-sm hover:bg-slate-800 transition-colors border border-slate-700 shrink-0">
          Logout
        </button>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-8 sm:space-y-10 w-full min-w-0">
      <p class="text-sm text-slate-500" id="file-status">${state.filesLabel}</p>

      ${state.page === "dashboard" ? dashboardStatsHtml : ""}

      <section class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div class="rounded-xl border border-slate-800 bg-surface-raised p-4 min-w-0">
          <h2 class="text-sm font-medium text-slate-400 mb-3">Equity curve</h2>
          <div class="h-52 sm:h-64"><canvas id="chart-equity"></canvas></div>
        </div>
        <section class="rounded-xl border border-slate-800 bg-surface-raised p-4 sm:p-5 min-w-0" id="equity-kpi-section">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 class="text-sm font-medium text-slate-400">Statistics</h2>
            <span id="kpi-equity-period" class="text-xs text-slate-400 font-medium px-2.5 py-1 rounded-md bg-surface-overlay border border-slate-700"></span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mb-4">
            <div class="min-w-0">
              <p id="kpi-cumulative-return" class="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-white">—</p>
              <p class="text-xs text-slate-500 mt-1.5">Cumulative return <span class="text-slate-600">(running sum of round-trip P&amp;L by close date)</span></p>
            </div>
            <div class="min-w-0">
              <p id="kpi-avg-rr" class="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums font-mono text-white">—</p>
              <p class="text-xs text-slate-500 mt-1.5">Average R:R <span class="text-slate-600">(mean of P&amp;L ÷ total risk for trades with total risk set)</span></p>
            </div>
          </div>
          <div class="h-14 w-full min-w-0">
            <canvas id="chart-equity-spark" class="w-full h-full" aria-label="Cumulative P&amp;L sparkline for this period"></canvas>
          </div>
        </section>
        <div class="rounded-xl border border-slate-800 bg-surface-raised p-4 min-w-0">
          <h2 class="text-sm font-medium text-slate-400 mb-3">P&amp;L by weekday (close)</h2>
          <div class="h-52 sm:h-64"><canvas id="chart-weekday"></canvas></div>
        </div>
      </section>

      ${state.page === "calendar" ? calendarHtml : ""}


    </main>
    </div>
    </div>

    <div class="lg:hidden" id="mobile-nav-shell" aria-hidden="true">
      <div id="mobile-nav-backdrop" class="fixed inset-0 z-[45] bg-black/60 opacity-0 pointer-events-none transition-opacity duration-200 ease-out" aria-hidden="true"></div>
      <div id="mobile-nav-panel" class="fixed left-0 top-0 bottom-0 z-[46] flex w-[min(17.5rem,86vw)] max-w-[300px] -translate-x-full flex-col border-r border-slate-700 bg-slate-900 shadow-2xl transition-transform duration-200 ease-out pt-[env(safe-area-inset-top,0px)] pb-[max(1rem,env(safe-area-inset-bottom,0px))]" role="dialog" aria-modal="true" aria-labelledby="mobile-nav-title" aria-hidden="true">
        <div class="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
          <h2 id="mobile-nav-title" class="text-sm font-semibold text-slate-200">Menu</h2>
          <button type="button" id="mobile-nav-close" class="min-h-[44px] min-w-[44px] shrink-0 rounded-lg text-lg leading-none text-slate-400 hover:bg-slate-800 hover:text-white transition-colors" aria-label="Close menu">&times;</button>
        </div>
        <nav class="flex flex-col gap-1 p-3" aria-label="Primary navigation">
          ${navBtn("dashboard", "Dashboard")}
          ${navBtn("calendar", "Calendar")}
        </nav>
      </div>
    </div>

    <div id="meta-popover" class="fixed z-[70] hidden pointer-events-none max-w-[280px]"></div>

    <div id="trade-row-menu" class="fixed z-[75] hidden rounded-lg border border-slate-700 bg-slate-900 py-1 min-w-[11rem] shadow-xl" role="menu">
      <button type="button" id="trade-row-menu-delete" class="w-full text-left px-3 py-2 text-sm text-loss hover:bg-slate-800/90 transition-colors" role="menuitem">Delete trade…</button>
    </div>

    <div id="modal" class="fixed inset-0 z-50 hidden items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-black/70 backdrop-blur-sm">
      <div class="bg-surface-raised border border-slate-800 rounded-xl max-w-lg w-full max-h-[min(90vh,100dvh-2rem)] overflow-y-auto shadow-2xl">
        <div class="p-4 border-b border-slate-800 flex justify-between items-start gap-4">
          <div>
            <h3 class="text-lg font-semibold text-white" id="modal-title"></h3>
            <p class="text-sm text-slate-500 font-mono mt-1" id="modal-sub"></p>
          </div>
          <button type="button" id="modal-close" class="text-slate-500 hover:text-white text-2xl leading-none">&times;</button>
        </div>
        <div class="p-4 space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Risk per share ($)</label>
            <input type="number" id="modal-risk" step="0.01" min="0" placeholder="e.g. stop distance per share" class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
            <p class="text-[11px] text-slate-600 mt-1">Total risk in the table uses peak shares × this value.</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Notes</label>
            <textarea id="modal-notes" rows="4" class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-accent" placeholder="Setup, mistakes, context…"></textarea>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Screenshot</label>
            <input type="file" accept="image/*" id="modal-shot" class="text-sm text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-surface-overlay file:text-slate-200" />
            <p class="text-[11px] text-slate-600 mt-1">Choose an image, then press <span class="text-slate-400">Save</span> at the bottom.</p>
            <div id="modal-preview" class="mt-3 rounded-lg overflow-hidden border border-slate-800 hidden">
              <img alt="" class="w-full max-h-64 object-contain bg-black/40" id="modal-img" />
            </div>
            <button type="button" id="modal-clear-shot" class="mt-2 text-xs text-slate-500 hover:text-loss hidden">Remove image</button>
          </div>
          <button type="button" id="modal-save" class="w-full min-h-[48px] py-3 sm:py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">Save</button>
        </div>
      </div>
    </div>
  `;

  bind();
  paintCharts();
  paintCalendar();
}



function statCard(title, value, hint = "") {
  return `
    <div class="rounded-xl border border-slate-800 bg-surface-raised p-4">
      <p class="text-xs font-medium text-slate-500 uppercase tracking-wide">${title}</p>
      <p class="text-2xl font-semibold text-white mt-1">${value}</p>
      ${hint ? `<p class="text-xs text-slate-600 mt-1">${hint}</p>` : ""}
    </div>`;
}

function formatPF(pf) {
  if (pf == null || !Number.isFinite(pf)) return "—";
  if (pf === Infinity) return "∞";
  return pf.toFixed(2);
}

/** Local wall-clock time when the round trip closed (last fill). */
function formatCloseTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function tradeMeta(id) {
  return state.tradeMetaById.get(id) || emptyTradeMeta(id);
}

function revokeAllScreenshotUrls() {
  for (const url of state.screenshotUrls.values()) {
    if (typeof url === "string" && url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  }
  state.screenshotUrls.clear();
}

/** IndexedDB stores screenshots as data URL strings (reliable). Legacy Blob still supported on read. */
function refreshScreenshotSrcForTrade(id, screenshot) {
  const prev = state.screenshotUrls.get(id);
  if (prev && typeof prev === "string" && prev.startsWith("blob:")) {
    URL.revokeObjectURL(prev);
  }
  if (typeof screenshot === "string" && screenshot.startsWith("data:")) {
    state.screenshotUrls.set(id, screenshot);
  } else if (screenshot instanceof Blob && screenshot.size > 0) {
    state.screenshotUrls.set(id, URL.createObjectURL(screenshot));
  } else {
    state.screenshotUrls.delete(id);
  }
}

function hasScreenshotStored(meta) {
  if (!meta) return false;
  if (meta.hasScreenshot) return true;
  const s = meta.screenshot;
  if (typeof s === "string" && s.startsWith("data:") && s.length > 32) return true;
  if (s instanceof Blob && s.size > 0) return true;
  return false;
}

async function hydrateTradeMeta() {
  revokeAllScreenshotUrls();
  state.tradeMetaById.clear();
  try {
    const rows = await apiGetAllMeta();
    for (const r of rows) {
      const id = r.trade_id;
      const m = {
        ...emptyTradeMeta(id),
        id,
        notes: r.notes || "",
        riskPerShare: r.risk_per_share ?? null,
        screenshotUrl: r.screenshot_url ?? null,
        hasScreenshot: !!r.screenshot_url,
      };
      state.tradeMetaById.set(id, m);
      if (r.screenshot_url) {
        state.screenshotUrls.set(id, r.screenshot_url);
      }
    }
  } catch (err) {
    console.error("Failed to load meta:", err);
  }
}

function closeMetaPopover() {
  clearTimeout(metaPopoverHideTimer);
  const pop = $("#meta-popover");
  if (pop) {
    pop.classList.add("hidden", "pointer-events-none");
  }
  metaPopoverAnchor = null;
}

function scheduleHideMetaPopover() {
  clearTimeout(metaPopoverHideTimer);
  metaPopoverHideTimer = setTimeout(() => {
    closeMetaPopover();
  }, 180);
}

function cancelHideMetaPopover() {
  clearTimeout(metaPopoverHideTimer);
}

/** Desktop: hover popover. Touch devices use tap (see bind). */
function metaPopoverHoverUsable() {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function positionMetaPopover(anchor) {
  const pop = $("#meta-popover");
  if (!pop || !anchor) return;
  const margin = 8;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const pw = Math.max(pr.width, 1);
  const ph = Math.max(pr.height, 1);
  const narrow = window.innerWidth < 640;

  let left = narrow
    ? r.left + (r.width - pw) / 2
    : r.right + margin;
  if (!narrow && left + pw > window.innerWidth - margin) {
    left = r.left - pw - margin;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

  let top = narrow ? r.bottom + margin : r.top;
  if (narrow && top + ph > window.innerHeight - margin) {
    top = Math.max(margin, r.top - ph - margin);
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function showMetaPopover(tradeId, anchor) {
  const pop = $("#meta-popover");
  if (!pop) return;
  cancelHideMetaPopover();
  metaPopoverAnchor = anchor;
  const meta = tradeMeta(tradeId);
  const note = (meta.notes || "").trim();
  const shotUrl = state.screenshotUrls.get(tradeId) || null;
  let inner = `<div class="popover-inner rounded-lg border border-slate-600 bg-slate-950 shadow-2xl p-3 w-[min(280px,calc(100vw-16px))] max-h-[min(28rem,calc(100svh-24px))] overflow-y-auto text-xs text-slate-200 space-y-2 pointer-events-auto">`;
  if (note) {
    inner += `<div class="text-slate-400 text-[10px] font-medium uppercase tracking-wide">Note</div><div class="whitespace-pre-wrap max-h-36 overflow-y-auto text-slate-200 leading-snug">${escapeHtml(note)}</div>`;
  }
  if (shotUrl) {
    inner += `<div class="text-slate-400 text-[10px] font-medium uppercase tracking-wide">Screenshot</div><img src="${shotUrl}" alt="" class="max-w-full max-h-44 object-contain rounded border border-slate-700 bg-black/30" />`;
  }
  if (!note && !shotUrl) {
    inner += `<p class="text-slate-500 text-center py-2">No note or screenshot yet.</p>`;
  }
  inner += `</div>`;
  pop.innerHTML = inner;
  pop.classList.remove("hidden", "pointer-events-none");
  positionMetaPopover(anchor);
  pop.querySelectorAll("img").forEach((img) => {
    if (img.complete) return;
    img.addEventListener(
      "load",
      () => metaPopoverAnchor && positionMetaPopover(metaPopoverAnchor),
      { once: true },
    );
  });
  const innerEl = pop.querySelector(".popover-inner");
  innerEl?.addEventListener("mouseenter", cancelHideMetaPopover);
  innerEl?.addEventListener("mouseleave", scheduleHideMetaPopover);
}

function closeTradeRowMenu() {
  const m = $("#trade-row-menu");
  if (m) m.classList.add("hidden");
  tradeMenuTradeId = null;
}

function openMobileNav() {
  if (window.matchMedia("(min-width: 1024px)").matches) return;
  const backdrop = $("#mobile-nav-backdrop");
  const panel = $("#mobile-nav-panel");
  const shell = $("#mobile-nav-shell");
  const openBtn = $("#mobile-nav-open");
  if (!backdrop || !panel) return;
  backdrop.classList.remove("opacity-0", "pointer-events-none");
  backdrop.classList.add("opacity-100");
  backdrop.setAttribute("aria-hidden", "false");
  panel.classList.remove("-translate-x-full");
  panel.setAttribute("aria-hidden", "false");
  shell?.setAttribute("aria-hidden", "false");
  openBtn?.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
}

function closeMobileNav() {
  const backdrop = $("#mobile-nav-backdrop");
  const panel = $("#mobile-nav-panel");
  const shell = $("#mobile-nav-shell");
  const openBtn = $("#mobile-nav-open");
  document.body.style.overflow = "";
  if (!backdrop || !panel) return;
  backdrop.classList.add("opacity-0", "pointer-events-none");
  backdrop.classList.remove("opacity-100");
  backdrop.setAttribute("aria-hidden", "true");
  panel.classList.add("-translate-x-full");
  panel.setAttribute("aria-hidden", "true");
  shell?.setAttribute("aria-hidden", "true");
  openBtn?.setAttribute("aria-expanded", "false");
}

function positionTradeRowMenu(anchorBtn) {
  const m = $("#trade-row-menu");
  if (!m || !anchorBtn) return;
  const r = anchorBtn.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  const margin = 8;
  let left = r.right - mr.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - mr.width - margin));
  let top = r.bottom + 4;
  if (top + mr.height > window.innerHeight - margin) {
    top = r.top - mr.height - 4;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - mr.height - margin));
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

function openTradeRowMenu(tradeId, anchorBtn) {
  tradeMenuTradeId = tradeId;
  const m = $("#trade-row-menu");
  if (!m) return;
  m.classList.remove("hidden");
  requestAnimationFrame(() => positionTradeRowMenu(anchorBtn));
}

function onGlobalClickForTradeMenu(e) {
  const menuBtn = e.target.closest(".trade-menu-btn");
  const menu = $("#trade-row-menu");
  if (menuBtn) {
    e.stopPropagation();
    const id = menuBtn.dataset.tradeId;
    if (!id) return;
    const isOpen =
      menu &&
      !menu.classList.contains("hidden") &&
      tradeMenuTradeId === id;
    if (isOpen) closeTradeRowMenu();
    else openTradeRowMenu(id, menuBtn);
    return;
  }
  if (!menu || menu.classList.contains("hidden")) return;
  if (e.target.closest("#trade-row-menu-delete")) {
    e.preventDefault();
    void promptDeleteTrade();
    return;
  }
  if (e.target.closest("#trade-row-menu")) return;
  closeTradeRowMenu();
}

async function promptDeleteTrade() {
  const id = tradeMenuTradeId;
  if (!id) return;
  const t = state.trades.find((x) => x.id === id);
  const label = t
    ? `${t.symbol} · ${t.dateKey}`
    : id.split("|").slice(0, 2).join(" · ");
  if (
    !confirm(
      `Remove this round trip from the list and delete its saved note, screenshot, and risk data?\n\n${label}`,
    )
  ) {
    return;
  }
  await performDeleteTrade(id);
}

function bind() {
  $("#file-input")?.addEventListener("change", async (e) => {
    const input = e.target;
    const files = input.files;
    
    if (!files?.length) return;
    const parts = await parseFiles(files);
    const { fills, balancePoints } = mergeExtracts(parts);
    const trades = buildRoundTripTrades(fills);
    state.trades = trades;
    try {
      await apiUpsertTrades(trades);
    } catch (err) {
        console.error("Failed to save trades:", err);
    }
    state.fileLoadInfo = { fileCount: parts.length, fillCount: fills.length };
    await hydrateTradeMeta();
    state.metrics = computeMetrics(trades);
    state.equity = buildEquitySeries(balancePoints);
    state.filesLabel = `Loaded ${parts.length} file(s) · ${fills.length} fills · ${trades.length} counted round trips`;
    if (trades.length) {
      state.calendarMonth = new Date(trades[0].closeTs);
    }
    state.selectedDay = null;
    render();
    input.value = "";
  });

  $("#cal-prev")?.addEventListener("click", () => {
    state.calendarMonth = new Date(
      state.calendarMonth.getFullYear(),
      state.calendarMonth.getMonth() - 1,
      1,
    );
    state.selectedDay = null;
    render();
  });
  $("#cal-next")?.addEventListener("click", () => {
    state.calendarMonth = new Date(
      state.calendarMonth.getFullYear(),
      state.calendarMonth.getMonth() + 1,
      1,
    );
    state.selectedDay = null;
    render();
  });
  $("#cal-clear")?.addEventListener("click", () => {
    state.selectedDay = null;
    render();
  });

  $("#trades-tbody")?.addEventListener("click", (e) => {
    if (e.target.closest(".no-row-open")) return;
    const tr = e.target.closest(".trade-row");
    if (tr?.dataset.id) openModal(tr.dataset.id);
  });

  $("#trades-mobile-cards")?.addEventListener("click", (e) => {
    if (e.target.closest(".no-row-open")) return;
    const card = e.target.closest(".trade-mobile-card");
    if (card?.dataset.id) openModal(card.dataset.id);
  });

  document.querySelectorAll(".risk-input").forEach((inp) => {
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("keydown", (ev) => ev.stopPropagation());
    inp.addEventListener("blur", () => {
      const id = inp.dataset.tradeId;
      if (id) persistRiskFromInput(id, inp);
    });
  });

  document.querySelectorAll(".meta-preview-trigger").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      if (metaPopoverHoverUsable()) {
        ev.stopPropagation();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.dataset.tradeId;
      if (id) showMetaPopover(id, btn);
    });
    btn.addEventListener("mouseenter", () => {
      if (!metaPopoverHoverUsable()) return;
      const id = btn.dataset.tradeId;
      if (id) showMetaPopover(id, btn);
    });
    btn.addEventListener("mouseleave", () => {
      if (!metaPopoverHoverUsable()) return;
      scheduleHideMetaPopover();
    });
  });

  if (!metaPopoverDocumentCloseBound) {
    metaPopoverDocumentCloseBound = true;
    document.addEventListener("click", (e) => {
      const pop = $("#meta-popover");
      if (!pop || pop.classList.contains("hidden")) return;
      if (e.target.closest("#meta-popover")) return;
      if (e.target.closest(".meta-preview-trigger")) return;
      closeMetaPopover();
    });
  }

  $("#modal-close")?.addEventListener("click", closeModal);
  $("#modal")?.addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  $("#modal-save")?.addEventListener("click", saveModal);
  $("#modal-clear-shot")?.addEventListener("click", clearModalShot);

  $("#modal-shot")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    modalScreenshotExplicitlyCleared = false;
    const url = await blobToDataUrl(f);
    modalScreenshotDataUrl = url;
    const img = $("#modal-img");
    if (img) img.src = url;
    $("#modal-preview")?.classList.remove("hidden");
    $("#modal-clear-shot")?.classList.remove("hidden");
  });

  $("#mobile-nav-open")?.addEventListener("click", () => openMobileNav());
  $("#mobile-nav-close")?.addEventListener("click", () => closeMobileNav());
  $("#mobile-nav-backdrop")?.addEventListener("click", () => closeMobileNav());
  $("#logout-btn")?.addEventListener("click", () => logout());
}

function paintCharts() {
  const eq = $("#chart-equity");
  const wd = $("#chart-weekday");
  const spark = $("#chart-equity-spark");
  const kpiReturn = $("#kpi-cumulative-return");
  const kpiAvgRr = $("#kpi-avg-rr");
  const kpiPeriod = $("#kpi-equity-period");
  if (!eq || !wd) return;

  let equitySlice = state.equity;
  let weekdayBars = state.metrics?.byWeekday;
  let tradesForKpis = state.trades;

  if (state.page === "calendar") {
    const d = state.calendarMonth;
    const y = d.getFullYear();
    const mo = d.getMonth();
    equitySlice = equitySeriesForMonth(state.equity, y, mo);
    tradesForKpis = tradesClosedInMonth(state.trades, y, mo);
    weekdayBars = computeMetrics(tradesForKpis).byWeekday;
    if (kpiPeriod) {
      kpiPeriod.textContent = d.toLocaleString(undefined, {
        month: "long",
        year: "numeric",
      });
    }
  } else if (kpiPeriod) {
    kpiPeriod.textContent = "All loaded data";
  }

  const cumSeries =
    state.page === "calendar"
      ? cumulativePnlDailySeries(state.trades, {
          y: state.calendarMonth.getFullYear(),
          mo: state.calendarMonth.getMonth(),
        })
      : cumulativePnlDailySeries(state.trades, null);
  const cumEnd =
    cumSeries.length > 0
      ? cumSeries[cumSeries.length - 1].cumulative
      : null;

  if (kpiReturn) {
    kpiReturn.textContent =
      cumEnd != null && Number.isFinite(cumEnd) ? formatUsd(cumEnd) : "—";
    kpiReturn.classList.remove(
      "text-gain",
      "text-loss",
      "text-white",
      "text-slate-300",
    );
    if (cumEnd == null || !Number.isFinite(cumEnd)) {
      kpiReturn.classList.add("text-white");
    } else if (cumEnd > 0) {
      kpiReturn.classList.add("text-gain");
    } else if (cumEnd < 0) {
      kpiReturn.classList.add("text-loss");
    } else {
      kpiReturn.classList.add("text-slate-300");
    }
  }

  const avgRr = averageRiskRewardForTrades(tradesForKpis);
  if (kpiAvgRr) {
    kpiAvgRr.textContent =
      avgRr != null && Number.isFinite(avgRr)
        ? `${avgRr.toFixed(2)}R`
        : "—";
    kpiAvgRr.classList.remove(
      "text-gain",
      "text-loss",
      "text-white",
      "text-slate-300",
    );
    if (avgRr == null || !Number.isFinite(avgRr)) {
      kpiAvgRr.classList.add("text-white");
    } else if (avgRr > 0) {
      kpiAvgRr.classList.add("text-gain");
    } else if (avgRr < 0) {
      kpiAvgRr.classList.add("text-loss");
    } else {
      kpiAvgRr.classList.add("text-slate-300");
    }
  }

  if (spark) {
    if (cumSeries.length >= 2) {
      renderCumulativeReturnSparkline(spark, cumSeries);
    } else if (cumSeries.length === 1) {
      renderCumulativeReturnSparkline(spark, [
        cumSeries[0],
        {
          dateKey: cumSeries[0].dateKey,
          cumulative: cumSeries[0].cumulative,
        },
      ]);
    } else {
      destroyChart(spark);
    }
  }

  if (equitySlice.length) {
    renderEquityChart(eq, equitySlice);
  } else {
    destroyChart(eq);
  }

  if (weekdayBars) {
    renderWeekdayChart(wd, weekdayBars);
  } else {
    destroyChart(wd);
  }
}

function paintCalendar() {
  const grid = $("#calendar-grid");
  const label = $("#cal-label");
  if (!grid || !label) return;

  const d = state.calendarMonth;
  const y = d.getFullYear();
  const mo = d.getMonth();
  label.textContent = d.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });

  const trades = state.trades;
  const weekRows = getWeekRowsForMonth(y, mo);
  const colTemplate =
    "grid-cols-[repeat(5,minmax(0,1fr))_minmax(9.5rem,1fr)] sm:grid-cols-[repeat(5,minmax(0,1fr))_minmax(12rem,1fr)]";

  const dowLabels = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  let html = `
    <div class="grid ${colTemplate} gap-2 text-xs text-slate-500 font-medium px-1">
      ${dowLabels.map((h) => `<div class="text-center py-1">${h}</div>`).join("")}
      <div class="text-center py-1 text-slate-400">Week summary</div>
    </div>`;

  for (const { monday } of weekRows) {
    const keys = [];
    let dayCells = "";
    for (let i = 0; i < 5; i++) {
      const dayDate = addDays(monday, i);
      const key = toDateKey(dayDate);
      keys.push(key);
      const inMonth = dayDate.getMonth() === mo;
      const st = dayStats(trades, key);
      const has = st.count > 0;
      const sel = state.selectedDay === key;
      const dom = dayDate.getDate();

      const pnlClass =
        st.pnl > 0 ? "text-gain" : st.pnl < 0 ? "text-loss" : "text-slate-400";
      const cardBg =
        st.pnl > 0
          ? "bg-gain/15 border-gain/35"
          : st.pnl < 0
            ? "bg-loss/15 border-loss/35"
            : has
              ? "bg-slate-800/60 border-slate-600"
              : "bg-surface-overlay/50 border-slate-800";

      const centerBlock = has
        ? `<div class="flex flex-col items-center justify-center gap-1 px-1 pb-2 pt-5">
             <span class="font-mono text-sm font-medium ${pnlClass}">${formatCompactUsd(st.pnl)}</span>
             <span class="text-[11px] leading-tight">
               <span class="text-gain font-medium">${st.wins}W</span>
               <span class="text-slate-600 mx-0.5"> </span>
               <span class="text-loss font-medium">${st.losses}L</span>
             </span>
           </div>`
        : `<div class="flex-1 min-h-[4rem]"></div>`;

      dayCells += `
        <button type="button" data-day="${key}"
          class="cal-cell relative rounded-xl border text-left min-h-[4.75rem] sm:min-h-[5.75rem] transition-all active:opacity-90 hover:ring-1 hover:ring-accent/40 ${cardBg} ${sel ? "ring-2 ring-accent" : ""} ${inMonth ? "" : "opacity-55"}">
          <span class="absolute top-2 right-2 text-xs font-medium ${inMonth ? "text-slate-400" : "text-slate-600"}">${dom}</span>
          ${centerBlock}
        </button>`;
    }

    const ws = weekStats(trades, keys);
    const totalCls =
      ws.pnl > 0 ? "text-gain" : ws.pnl < 0 ? "text-loss" : "text-slate-300";
    const wrStr =
      ws.winRate == null ? "—" : `${(ws.winRate * 100).toFixed(1)}%`;
    const pfStr = formatPF(ws.profitFactor);

    html += `
      <div class="grid ${colTemplate} gap-2 items-stretch">
        ${dayCells}
        <div class="rounded-xl border border-slate-700/80 bg-slate-900/40 px-3 py-3 grid grid-cols-3 gap-2 text-center">
          <div>
            <div class="font-mono text-sm font-semibold ${totalCls}">${formatCompactUsd(ws.pnl)}</div>
            <div class="text-[10px] text-slate-500 mt-0.5">Total</div>
          </div>
          <div>
            <div class="font-mono text-sm font-semibold text-slate-200">${wrStr}</div>
            <div class="text-[10px] text-slate-500 mt-0.5">Win rate</div>
          </div>
          <div>
            <div class="font-mono text-sm font-semibold text-slate-200">${pfStr}</div>
            <div class="text-[10px] text-slate-500 mt-0.5">Profit factor</div>
          </div>
        </div>
      </div>`;
  }

  grid.innerHTML = html;
  grid.querySelectorAll(".cal-cell").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.day;
      state.selectedDay = state.selectedDay === key ? null : key;
      render();
    });
  });
}

let modalScreenshotDataUrl = null;
let modalCurrentId = null;

async function openModal(tradeId) {
  closeMetaPopover();
  closeMobileNav();
  const t = state.trades.find((x) => x.id === tradeId);
  if (!t) return;
  state.detailTrade = t;
  modalCurrentId = tradeId;
  modalScreenshotExplicitlyCleared = false;
  let meta = state.tradeMetaById.get(tradeId);
  if (!meta) {
    meta = emptyTradeMeta(tradeId);
    state.tradeMetaById.set(tradeId, meta);
  }
  modalScreenshotDataUrl = meta.screenshotUrl ?? null;

  $("#modal").classList.remove("hidden");
  $("#modal").classList.add("flex");
  $("#modal-title").textContent = `${t.symbol} · ${t.openSide}`;
  $("#modal-sub").textContent = `${t.id.split("|").slice(0, 2).join(" · ")}`;
  $("#modal-notes").value = meta.notes || "";
  const mr = $("#modal-risk");
  if (mr) {
    mr.value =
      meta.riskPerShare != null && Number.isFinite(Number(meta.riskPerShare))
        ? String(meta.riskPerShare)
        : "";
  }

  const prev = $("#modal-preview");
  const img = $("#modal-img");
  const clr = $("#modal-clear-shot");
  if (modalScreenshotDataUrl) {
    img.src = modalScreenshotDataUrl;
    prev.classList.remove("hidden");
    clr.classList.remove("hidden");
  } else {
    prev.classList.add("hidden");
    clr.classList.add("hidden");
    img.src = "";
  }
  $("#modal-shot").value = "";
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modal").classList.remove("flex");
  modalCurrentId = null;
  modalScreenshotDataUrl = null;
}

async function performDeleteTrade(id) {
  closeTradeRowMenu();
  try {
    await Promise.all([
      apiDeleteMeta(id),
      apiDeleteTrade(id),
    ]);
  } catch (err) {
    console.error(err);
    alert(err?.message ? `Could not delete saved data: ${err.message}` : "Could not delete saved data.");
    return;
  }
  const prevUrl = state.screenshotUrls.get(id);
  if (prevUrl && typeof prevUrl === "string" && prevUrl.startsWith("blob:")) {
    URL.revokeObjectURL(prevUrl);
  }
  state.screenshotUrls.delete(id);
  state.tradeMetaById.delete(id);
  state.trades = state.trades.filter((t) => t.id !== id);
  state.metrics = computeMetrics(state.trades);
  if (modalCurrentId === id) closeModal();
  if (state.fileLoadInfo) {
    state.filesLabel = `Loaded ${state.fileLoadInfo.fileCount} file(s) · ${state.fileLoadInfo.fillCount} fills · ${state.trades.length} counted round trips`;
  }
  render();
}

function clearModalShot() {
  modalScreenshotExplicitlyCleared = true;
  modalScreenshotDataUrl = null;
  $("#modal-img").src = "";
  $("#modal-preview").classList.add("hidden");
  $("#modal-clear-shot").classList.add("hidden");
  $("#modal-shot").value = "";
}

async function saveModal() {
  if (!modalCurrentId) return;

  const rawRisk = $("#modal-risk")?.value?.trim() ?? "";
  const patch = {
    id: modalCurrentId,
    notes: $("#modal-notes").value,
  };
  if (rawRisk === "") {
    patch.riskPerShare = null;
  } else {
    const n = Number(rawRisk);
    if (Number.isFinite(n) && n >= 0) patch.riskPerShare = n;
  }

  try {
    let screenshotUrl = state.tradeMetaById.get(modalCurrentId)?.screenshotUrl ?? null;

    if (modalScreenshotExplicitlyCleared) {
      screenshotUrl = null;
    } else if (modalScreenshotDataUrl) {
      const file = await (await fetch(modalScreenshotDataUrl)).blob();
      const compressed = await compressImage(file);
      screenshotUrl = await apiUploadScreenshot(compressed);
    }

    await apiUpsertMeta({
      id: modalCurrentId,
      notes: patch.notes,
      riskPerShare: patch.riskPerShare ?? null,
      screenshotUrl,
    });

    const updated = {
      ...emptyTradeMeta(modalCurrentId),
      ...state.tradeMetaById.get(modalCurrentId),
      notes: patch.notes,
      riskPerShare: patch.riskPerShare ?? null,
      screenshotUrl,
      hasScreenshot: !!screenshotUrl,
    };
    state.tradeMetaById.set(modalCurrentId, updated);
    if (screenshotUrl) {
      state.screenshotUrls.set(modalCurrentId, screenshotUrl);
    } else {
      state.screenshotUrls.delete(modalCurrentId);
    }
    closeModal();
    render();
  } catch (err) {
    console.error(err);
    alert(err?.message ? `Save failed: ${err.message}` : "Save failed.");
  }
}

async function compressImage(blob, maxWidth = 1280, quality = 0.7) {
  const img = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / img.width);
  const canvas = document.createElement("canvas");
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Sidebar nav: one listener on #app so it survives every `render()` (buttons are recreated each time). */
document.querySelector("#app")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-nav-page]");
  if (!btn) return;
  const page = btn.dataset.navPage;
  if (page !== "dashboard" && page !== "calendar") return;
  closeMobileNav();
  state.page = page;
  render();
});

document.addEventListener("click", onGlobalClickForTradeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const menu = $("#trade-row-menu");
  if (menu && !menu.classList.contains("hidden")) {
    closeTradeRowMenu();
    return;
  }
  const mPanel = $("#mobile-nav-panel");
  if (mPanel && !mPanel.classList.contains("-translate-x-full")) {
    closeMobileNav();
  }
});
window.addEventListener("resize", () => {
  closeTradeRowMenu();
  if (window.matchMedia("(min-width: 1024px)").matches) closeMobileNav();
});

if (!isLoggedIn()) {
  showAuthScreen();
} else {
  apiGetTrades().then(rows => {
    if (rows.length) {
      state.trades = rows.map(r => ({
        id: r.id,
        symbol: r.symbol,
        openSide: r.open_side,
        dateKey: r.date_key,
        openTs: r.open_ts,
        closeTs: r.close_ts,
        pnl: r.pnl,
        maxShares: r.max_shares,
        shareTurnover: r.share_turnover,
        twoWayNotional: r.two_way_notional,
        returnPerDollar: r.return_per_dollar,
        win: r.pnl > 0,
      }));
      state.metrics = computeMetrics(state.trades);
      state.calendarMonth = new Date(state.trades[state.trades.length - 1].closeTs);
      state.filesLabel = `${state.trades.length} trades loaded from database`;
    }
    hydrateTradeMeta().then(() => render());
  }).catch(err => {
    console.error("Failed to load trades:", err);
    render();
  });
}
