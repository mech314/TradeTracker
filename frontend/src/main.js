import "./style.css";
import {
  extractFillsAndBalances,
  buildRoundTripTrades,
  buildEquitySeries,
} from "./engine.js";
import { computeMetrics, formatPct, formatUsd } from "./metrics.js";
import { renderEquityChart, renderWeekdayChart } from "./charts.js";
import {
  loadTradeMeta,
  saveTradeMeta,
  loadAllTradeMeta,
  emptyTradeMeta,
  blobToDataUrl,
  deleteTradeMeta,
} from "./storage.js";

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
};

let metaPopoverHideTimer = null;
let metaPopoverAnchor = null;
let modalScreenshotExplicitlyCleared = false;
let tradeMenuTradeId = null;

function pad2(n) {
  return String(n).padStart(2, "0");
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

function tradeRowHtml(t) {
  const meta = tradeMeta(t.id);
  const hasNote = (meta.notes || "").trim().length > 0;
  const hasShot =
    state.screenshotUrls.has(t.id) || hasScreenshotStored(meta);
  const rps = meta.riskPerShare;
  const rpsNum =
    rps != null && rps !== "" && Number.isFinite(Number(rps))
      ? Number(rps)
      : null;
  const totalRisk =
    rpsNum != null && t.maxShares > 0 ? rpsNum * t.maxShares : null;
  const riskVal = rpsNum != null ? String(rpsNum) : "";
  const noteClass = hasNote
    ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/40"
    : "bg-slate-800 text-slate-600";
  const shotClass = hasShot
    ? "bg-sky-500/25 text-sky-200 ring-1 ring-sky-500/40"
    : "bg-slate-800 text-slate-600";
  const shareTitle = `Peak shares: ${t.maxShares} · Round-turn volume: ${t.shareTurnover}`;
  const totalStr =
    totalRisk != null
      ? `<span class="font-mono ${totalRisk >= 0 ? "text-slate-300" : "text-loss"}">${formatUsd(totalRisk)}</span>`
      : `<span class="text-slate-600">—</span>`;
  return `
    <tr class="hover:bg-surface-overlay/60 cursor-pointer transition-colors trade-row group" data-id="${escapeAttr(t.id)}">
      <td class="px-3 py-2 font-mono text-slate-400">${t.dateKey}</td>
      <td class="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">${formatCloseTime(t.closeTs)}</td>
      <td class="px-3 py-2 font-medium text-white">${t.symbol}</td>
      <td class="px-3 py-2 text-slate-400">${t.openSide}</td>
      <td class="px-3 py-2 text-right font-mono text-slate-300" title="${escapeAttr(shareTitle)}">${t.maxShares}</td>
      <td class="px-3 py-2 text-right no-row-open">
        <input type="number" step="0.01" min="0" placeholder="—" class="risk-input w-[4.5rem] px-2 py-1 rounded-md bg-surface border border-slate-700 text-slate-200 text-right font-mono text-xs focus:outline-none focus:ring-1 focus:ring-accent" data-trade-id="${escapeAttr(t.id)}" value="${escapeAttr(riskVal)}" />
      </td>
      <td class="px-3 py-2 text-right font-mono text-sm" data-risk-total="${escapeAttr(t.id)}">${totalStr}</td>
      <td class="px-3 py-2 text-right font-mono ${t.pnl > 0 ? "text-gain" : "text-loss"}">${formatUsd(t.pnl)}</td>
      <td class="px-3 py-2 text-right font-mono text-slate-400">${t.returnPerDollar == null ? "—" : formatPct(t.returnPerDollar)}</td>
      <td class="px-3 py-2">${t.win ? '<span class="text-gain">Win</span>' : '<span class="text-loss">Loss</span>'}</td>
      <td class="px-2 py-2 no-row-open text-center">
        <button type="button" class="meta-preview-trigger inline-flex items-center justify-center gap-1.5 px-1 py-1 rounded-lg hover:bg-slate-800/80 transition-colors" data-trade-id="${escapeAttr(t.id)}" aria-label="Preview notes and screenshot">
          <span class="inline-flex h-6 min-w-[1.5rem] px-1 items-center justify-center rounded text-[10px] font-semibold ${noteClass}">N</span>
          <span class="inline-flex h-6 min-w-[1.5rem] px-1 items-center justify-center rounded text-[10px] font-semibold ${shotClass}">S</span>
        </button>
      </td>
      <td class="px-1 py-2 no-row-open text-right w-10">
        <button type="button" class="trade-menu-btn p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800/80 transition-colors" data-trade-id="${escapeAttr(t.id)}" aria-label="Trade options" aria-haspopup="menu" aria-expanded="false">⋮</button>
      </td>
    </tr>`;
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
    merged = await saveTradeMeta({ id: tradeId, riskPerShare });
  } catch (err) {
    console.error(err);
    alert(err?.message ? `Save failed: ${err.message}` : "Save failed.");
    return;
  }
  state.tradeMetaById.set(tradeId, merged);
  const t = state.trades.find((x) => x.id === tradeId);
  const cell = document.querySelector(
    `[data-risk-total="${CSS.escape(tradeId)}"]`,
  );
  if (cell && t) {
    const tr =
      riskPerShare != null && t.maxShares > 0 ? riskPerShare * t.maxShares : null;
    cell.innerHTML =
      tr != null
        ? `<span class="font-mono ${tr >= 0 ? "text-slate-300" : "text-loss"}">${formatUsd(tr)}</span>`
        : `<span class="text-slate-600">—</span>`;
  }
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
  const root = $("#app");
  const m = state.metrics;
  const trades = state.trades;
  const dayFilter = state.selectedDay;

  const filtered =
    dayFilter == null
      ? trades
      : trades
          .filter((t) => t.dateKey === dayFilter)
          .sort((a, b) => a.closeTs - b.closeTs);

  root.innerHTML = `
    <header class="border-b border-slate-800/80 bg-surface-raised/50 backdrop-blur-sm sticky top-0 z-30">
      <div class="max-w-7xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-white">TradeTracker</h1>
          <p class="text-sm text-slate-500 mt-0.5">Same-day round trips · long & short · no fees in P&amp;L</p>
        </div>
        <label class="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors border border-accent/30">
          <input type="file" accept=".csv,text/csv" multiple class="hidden" id="file-input" />
          Load CSV
        </label>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-8 space-y-10">
      <p class="text-sm text-slate-500" id="file-status">${state.filesLabel}</p>

      <section class="grid sm:grid-cols-2 lg:grid-cols-5 gap-4" id="stat-cards">
        ${statCard("Counted trades", m ? String(m.tradeCount) : "—")}
        ${statCard("Win rate", m ? formatPct(m.winRate) : "—", "Breakeven counts as loss")}
        ${statCard("Profit factor", m ? formatPF(m.profitFactor) : "—")}
        ${statCard("Avg return per dollar", m ? formatPct(m.avgReturnPerDollar) : "—", "Mean of each trade’s P&amp;L ÷ (½ × sum of |fill amounts|)")}
        ${statCard("Total P&amp;L", m ? formatUsd(m.totalPnl) : "—")}
      </section>

      <section class="grid lg:grid-cols-2 gap-6">
        <div class="rounded-xl border border-slate-800 bg-surface-raised p-4">
          <h2 class="text-sm font-medium text-slate-400 mb-3">Equity curve</h2>
          <div class="h-64"><canvas id="chart-equity"></canvas></div>
        </div>
        <div class="rounded-xl border border-slate-800 bg-surface-raised p-4">
          <h2 class="text-sm font-medium text-slate-400 mb-3">P&amp;L by weekday (close)</h2>
          <div class="h-64"><canvas id="chart-weekday"></canvas></div>
        </div>
      </section>

      <section class="rounded-xl border border-slate-800 bg-surface-raised p-4">
        <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
          <h2 class="text-sm font-medium text-slate-400">Calendar</h2>
          <div class="flex items-center gap-2">
            <button type="button" id="cal-prev" class="px-3 py-1.5 rounded-lg bg-surface-overlay text-sm text-slate-300 hover:bg-slate-800">←</button>
            <span class="text-sm text-slate-300 min-w-[9rem] text-center" id="cal-label"></span>
            <button type="button" id="cal-next" class="px-3 py-1.5 rounded-lg bg-surface-overlay text-sm text-slate-300 hover:bg-slate-800">→</button>
            ${state.selectedDay ? `<button type="button" id="cal-clear" class="text-xs text-accent ml-2">Clear day</button>` : ""}
          </div>
        </div>
        <div class="overflow-x-auto -mx-1 px-1">
          <div id="calendar-grid" class="space-y-2 text-sm min-w-[640px]"></div>
        </div>
      </section>

      <section class="rounded-xl border border-slate-800 bg-surface-raised overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-800 flex flex-wrap justify-between gap-2">
          <h2 class="text-sm font-medium text-slate-400">Trades</h2>
          <span class="text-xs text-slate-500">${dayFilter ? `Day: ${dayFilter} · sorted by close time` : "All days"} · ${filtered.length} shown</span>
        </div>
        <div class="overflow-x-auto">
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
                <th class="px-3 py-2 font-medium text-right">P&amp;L</th>
                <th class="px-3 py-2 font-medium text-right cursor-help underline decoration-slate-600 decoration-dotted underline-offset-4" title="This trade’s P&amp;L divided by half the sum of absolute fill amounts (same basis as “Avg return per dollar”).">Return / $</th>
                <th class="px-3 py-2 font-medium">Result</th>
                <th class="px-3 py-2 font-medium text-center cursor-help" title="Hover for note and screenshot preview.">Notes</th>
                <th class="px-2 py-2 font-medium text-right w-10"><span class="sr-only">Options</span></th>
              </tr>
            </thead>
            <tbody id="trades-tbody" class="divide-y divide-slate-800/80">
              ${filtered.map((t) => tradeRowHtml(t)).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <div id="meta-popover" class="fixed z-[70] hidden pointer-events-none max-w-[280px]"></div>

    <div id="trade-row-menu" class="fixed z-[75] hidden rounded-lg border border-slate-700 bg-slate-900 py-1 min-w-[11rem] shadow-xl" role="menu">
      <button type="button" id="trade-row-menu-delete" class="w-full text-left px-3 py-2 text-sm text-loss hover:bg-slate-800/90 transition-colors" role="menuitem">Delete trade…</button>
    </div>

    <div id="modal" class="fixed inset-0 z-50 hidden items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div class="bg-surface-raised border border-slate-800 rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
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
          <button type="button" id="modal-save" class="w-full py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">Save</button>
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
  const rows = await loadAllTradeMeta();
  for (const r of rows) {
    const id = r.id;
    const m = { ...emptyTradeMeta(id), ...r, id };
    state.tradeMetaById.set(id, m);
    refreshScreenshotSrcForTrade(id, m.screenshot);
  }
}

function scheduleHideMetaPopover() {
  clearTimeout(metaPopoverHideTimer);
  metaPopoverHideTimer = setTimeout(() => {
    const pop = $("#meta-popover");
    if (pop) {
      pop.classList.add("hidden", "pointer-events-none");
      metaPopoverAnchor = null;
    }
  }, 180);
}

function cancelHideMetaPopover() {
  clearTimeout(metaPopoverHideTimer);
}

function positionMetaPopover(anchor) {
  const pop = $("#meta-popover");
  if (!pop || !anchor) return;
  const margin = 8;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const pw = Math.max(pr.width, 1);
  const ph = Math.max(pr.height, 1);

  let left = r.right + margin;
  if (left + pw > window.innerWidth - margin) {
    left = r.left - pw - margin;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

  let top = r.top;
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
  let inner = `<div class="popover-inner rounded-lg border border-slate-600 bg-slate-950 shadow-2xl p-3 max-w-[280px] max-h-[min(28rem,calc(100svh-24px))] overflow-y-auto text-xs text-slate-200 space-y-2 pointer-events-auto">`;
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
    state.fileLoadInfo = { fileCount: parts.length, fillCount: fills.length };
    await hydrateTradeMeta();
    state.metrics = computeMetrics(trades);
    state.equity = buildEquitySeries(balancePoints);
    state.filesLabel = `Loaded ${parts.length} file(s) · ${fills.length} fills · ${trades.length} counted round trips`;
    if (trades.length) {
      state.calendarMonth = new Date(trades[trades.length - 1].closeTs);
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
    paintCalendar();
  });
  $("#cal-next")?.addEventListener("click", () => {
    state.calendarMonth = new Date(
      state.calendarMonth.getFullYear(),
      state.calendarMonth.getMonth() + 1,
      1,
    );
    paintCalendar();
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

  document.querySelectorAll(".risk-input").forEach((inp) => {
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("keydown", (ev) => ev.stopPropagation());
    inp.addEventListener("blur", () => {
      const id = inp.dataset.tradeId;
      if (id) persistRiskFromInput(id, inp);
    });
  });

  document.querySelectorAll(".meta-preview-trigger").forEach((btn) => {
    btn.addEventListener("click", (ev) => ev.stopPropagation());
    btn.addEventListener("mouseenter", () => {
      const id = btn.dataset.tradeId;
      if (id) showMetaPopover(id, btn);
    });
    btn.addEventListener("mouseleave", scheduleHideMetaPopover);
  });

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
}

function paintCharts() {
  const eq = $("#chart-equity");
  const wd = $("#chart-weekday");
  if (eq && state.equity.length) {
    renderEquityChart(eq, state.equity);
  }
  if (wd && state.metrics) {
    renderWeekdayChart(wd, state.metrics.byWeekday);
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
    "grid-cols-[repeat(5,minmax(0,1fr))_minmax(12rem,1fr)]";

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
          class="cal-cell relative rounded-xl border text-left min-h-[5.75rem] transition-all hover:ring-1 hover:ring-accent/40 ${cardBg} ${sel ? "ring-2 ring-accent" : ""} ${inMonth ? "" : "opacity-55"}">
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
  const t = state.trades.find((x) => x.id === tradeId);
  if (!t) return;
  state.detailTrade = t;
  modalCurrentId = tradeId;
  modalScreenshotExplicitlyCleared = false;
  let meta = state.tradeMetaById.get(tradeId);
  if (!meta) {
    meta = await loadTradeMeta(tradeId);
    state.tradeMetaById.set(tradeId, meta);
  }
  const sh = meta.screenshot;
  if (typeof sh === "string" && sh.startsWith("data:")) {
    modalScreenshotDataUrl = sh;
  } else if (sh instanceof Blob && sh.size > 0) {
    modalScreenshotDataUrl = await blobToDataUrl(sh);
  } else {
    modalScreenshotDataUrl = null;
  }

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
    await deleteTradeMeta(id);
  } catch (err) {
    console.error(err);
    alert(
      err?.message
        ? `Could not delete saved data: ${err.message}`
        : "Could not delete saved data.",
    );
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
  const existing = await loadTradeMeta(modalCurrentId);

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

  if (modalScreenshotExplicitlyCleared) {
    patch.screenshot = null;
  } else if (
    modalScreenshotDataUrl &&
    typeof modalScreenshotDataUrl === "string" &&
    modalScreenshotDataUrl.startsWith("data:")
  ) {
    patch.screenshot = modalScreenshotDataUrl;
  }

  try {
    const merged = await saveTradeMeta(patch);
    state.tradeMetaById.set(modalCurrentId, merged);
    refreshScreenshotSrcForTrade(modalCurrentId, merged.screenshot);
    closeModal();
    render();
  } catch (err) {
    console.error(err);
    alert(
      err?.message
        ? `Save failed: ${err.message}`
        : "Save failed (IndexedDB). Check the console.",
    );
  }
}

document.addEventListener("click", onGlobalClickForTradeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const menu = $("#trade-row-menu");
  if (menu && !menu.classList.contains("hidden")) closeTradeRowMenu();
});
window.addEventListener("resize", () => closeTradeRowMenu());

render();
