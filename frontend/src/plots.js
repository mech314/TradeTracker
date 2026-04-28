import Chart from "chart.js/auto";
import { destroyChart } from "./charts.js";

const grid = "rgba(148, 163, 184, 0.12)";

const LS_PLOT_LAYOUT = "tradetracker_plot_layout_v2";

/** Same semantic columns as the calendar trades table (numeric axes for charts). */
export const PLOT_FIELD_OPTIONS = Object.freeze([
  { id: "dateKey", label: "Close date", hint: "Days since epoch (UTC)" },
  { id: "openTs", label: "Opened (time)", hint: "Unix ms, first fill" },
  { id: "closeTs", label: "Closed (time)", hint: "Unix ms, last fill" },
  { id: "symbol", label: "Symbol", hint: "Stable hash (tooltip shows ticker)" },
  { id: "openSide", label: "Side", hint: "LONG=1 · SHORT=0" },
  { id: "maxShares", label: "Shares", hint: "Peak shares" },
  { id: "shareTurnover", label: "Share turnover", hint: "" },
  { id: "twoWayNotional", label: "Two-way notional", hint: "½ sum |cash|" },
  { id: "returnPerDollar", label: "Return / dollar", hint: "" },
  { id: "riskPerShare", label: "Risk/sh ($)", hint: "From saved meta" },
  { id: "totalRisk", label: "Total risk ($)", hint: "Risk/sh × shares" },
  { id: "rr", label: "R:R", hint: "P&L ÷ total risk" },
  { id: "pnl", label: "P&L ($)", hint: "" },
  {
    id: "mae",
    label: "MAE ($)",
    hint: "Max adverse excursion — worst move against you (manual)",
  },
  {
    id: "mfe",
    label: "MFE ($)",
    hint: "Max favorable excursion — best move in your favor (manual)",
  },
  {
    id: "result",
    label: "Result",
    hint: "Win=1 · Loss/Breakeven=0 (same basis as table sort)",
  },
  { id: "notesLen", label: "Notes length", hint: "Character count" },
]);

const FIELD_IDS = new Set(PLOT_FIELD_OPTIONS.map((f) => f.id));

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function symbolHash(sym) {
  const s = String(sym ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
  }
  return (h >>> 0) % 100000;
}

function dateKeyToNumber(dk) {
  const ck = String(dk ?? "").trim();
  const m = ck.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

function rrValue(t, meta) {
  const rps = meta?.riskPerShare;
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

/** Numeric value for an axis / histogram binning (aligned with trades table). */
export function getPlotFieldValue(id, trade, meta) {
  if (!FIELD_IDS.has(id)) return null;
  switch (id) {
    case "dateKey":
      return dateKeyToNumber(trade.dateKey);
    case "openTs":
      return Number.isFinite(trade.openTs) ? trade.openTs : null;
    case "closeTs":
      return Number.isFinite(trade.closeTs) ? trade.closeTs : null;
    case "symbol":
      return symbolHash(trade.symbol);
    case "openSide":
      return String(trade.openSide).toUpperCase().startsWith("L") ? 1 : 0;
    case "maxShares":
      return Number.isFinite(trade.maxShares) ? trade.maxShares : null;
    case "shareTurnover":
      return Number.isFinite(trade.shareTurnover) ? trade.shareTurnover : null;
    case "twoWayNotional":
      return Number.isFinite(trade.twoWayNotional) ? trade.twoWayNotional : null;
    case "returnPerDollar":
      return trade.returnPerDollar != null && Number.isFinite(trade.returnPerDollar)
        ? trade.returnPerDollar
        : null;
    case "riskPerShare": {
      const rps = meta?.riskPerShare;
      return rps != null && rps !== "" && Number.isFinite(Number(rps))
        ? Number(rps)
        : null;
    }
    case "totalRisk": {
      const rps = meta?.riskPerShare;
      const rpsNum =
        rps != null && rps !== "" && Number.isFinite(Number(rps))
          ? Number(rps)
          : null;
      return rpsNum != null && trade.maxShares > 0
        ? rpsNum * trade.maxShares
        : null;
    }
    case "rr":
      return rrValue(trade, meta);
    case "pnl":
      return Number.isFinite(trade.pnl) ? trade.pnl : null;
    case "mae": {
      const v = meta?.mae;
      return v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0
        ? Number(v)
        : null;
    }
    case "mfe": {
      const v = meta?.mfe;
      return v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0
        ? Number(v)
        : null;
    }
    case "result":
      return trade.win ? 1 : 0;
    case "notesLen":
      return (meta?.notes && String(meta.notes).length) || 0;
    default:
      return null;
  }
}

function fieldSelectHtml(selectedId, nameSuffix) {
  return `<select data-plot-prop="${nameSuffix}" class="select-flat w-full min-h-[38px] rounded-lg border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent/80">${PLOT_FIELD_OPTIONS.map(
    (f) =>
      `<option value="${escapeHtml(f.id)}"${f.id === selectedId ? " selected" : ""}>${escapeHtml(f.label)}</option>`,
  ).join("")}</select>`;
}

export function defaultDatasetScatter() {
  return { label: "Trades", color: "#a78bfa", tags: "" };
}

export function defaultDatasetHistogram() {
  return { label: "Series", color: "#34d399", tags: "" };
}

function defaultScatterPlot(i) {
  return {
    chartType: "scatter",
    xKey: "openTs",
    yKey: "pnl",
    xLog: false,
    yLog: false,
    /** `calendar` = real dates on X; `session` = local clock within session only (no dates), X = minutes from session open. */
    scatterTimeMode: "calendar",
    sessionStartMinutes: 7 * 60 + 30,
    sessionEndMinutes: 15 * 60,
    timeBinMinutes: 0,
    timeAgg: "sum",
    datasets: [defaultDatasetScatter()],
  };
}

const TIME_BIN_PRESETS = Object.freeze([
  { min: 0, label: "None (one point per trade)" },
  { min: 1, label: "1 min" },
  { min: 5, label: "5 min" },
  { min: 10, label: "10 min" },
  { min: 15, label: "15 min" },
  { min: 30, label: "30 min" },
  { min: 60, label: "1 hour" },
  { min: 240, label: "4 hours" },
  { min: 1440, label: "1 day" },
]);

export function defaultHistogramPlot() {
  return {
    chartType: "histogram",
    valueKey: "pnl",
    bins: 20,
    /** Per bin: count trades (default), or sum/mean/max/min of valueKey across trades in bin. */
    histAgg: "count",
    valueLog: false,
    freqLog: false,
    datasets: [
      { label: "Strategy A", color: "#34d399", tags: "" },
      { label: "Strategy B", color: "#f472b6", tags: "" },
    ],
  };
}

function defaultPlotSlot(i) {
  if (i === 1) return defaultHistogramPlot();
  return defaultScatterPlot(i);
}

export function defaultPlotLayout() {
  const gridCount = 3;
  const cols = 2;
  return {
    gridCount,
    cols,
    plots: Array.from({ length: gridCount }, (_, i) => defaultPlotSlot(i)),
  };
}

export function clampPlotSlot(raw, index) {
  const ct = raw?.chartType === "histogram" ? "histogram" : "scatter";
  if (ct === "histogram") {
    const bins = Math.min(
      80,
      Math.max(4, Number(raw?.bins) || 20),
    );
    const datasets = Array.isArray(raw?.datasets) ? raw.datasets : [];
    const dsNorm =
      datasets.length > 0
        ? datasets.map((d) => ({
            label: String(d?.label ?? "Series").slice(0, 48),
            color: String(d?.color ?? "#94a3b8").slice(0, 32),
            tags: String(d?.tags ?? ""),
          }))
        : [defaultDatasetHistogram()];
    const aggOk = new Set(["sum", "mean", "count", "max", "min"]);
    let histAgg = String(raw?.histAgg ?? "count").toLowerCase();
    if (!aggOk.has(histAgg)) histAgg = "count";
    return {
      chartType: "histogram",
      valueKey: FIELD_IDS.has(raw?.valueKey) ? raw.valueKey : "pnl",
      bins,
      histAgg,
      valueLog: Boolean(raw?.valueLog),
      freqLog: Boolean(raw?.freqLog),
      datasets: dsNorm.slice(0, 8),
    };
  }
  const xKey = FIELD_IDS.has(raw?.xKey) ? raw.xKey : "openTs";
  const yKey = FIELD_IDS.has(raw?.yKey) ? raw.yKey : "pnl";
  const datasets = Array.isArray(raw?.datasets) ? raw.datasets : [];
  const dsNorm =
    datasets.length > 0
      ? datasets.map((d) => ({
          label: String(d?.label ?? "Series").slice(0, 48),
          color: String(d?.color ?? "#94a3b8").slice(0, 32),
          tags: String(d?.tags ?? ""),
        }))
      : [defaultDatasetScatter()];
  let timeBinMinutes = Number(raw?.timeBinMinutes);
  if (!Number.isFinite(timeBinMinutes)) timeBinMinutes = 0;
  timeBinMinutes = Math.min(10080, Math.max(0, Math.round(timeBinMinutes)));
  const aggOk = new Set(["sum", "mean", "count", "max", "min"]);
  let timeAgg = String(raw?.timeAgg ?? "sum").toLowerCase();
  if (!aggOk.has(timeAgg)) timeAgg = "sum";
  let scatterTimeMode = String(raw?.scatterTimeMode ?? "calendar").toLowerCase();
  if (scatterTimeMode === "timeofday") scatterTimeMode = "session";
  if (scatterTimeMode !== "session") scatterTimeMode = "calendar";
  let sessionStartMinutes = Number(raw?.sessionStartMinutes);
  let sessionEndMinutes = Number(raw?.sessionEndMinutes);
  if (!Number.isFinite(sessionStartMinutes)) sessionStartMinutes = 7 * 60 + 30;
  if (!Number.isFinite(sessionEndMinutes)) sessionEndMinutes = 15 * 60;
  sessionStartMinutes = Math.min(1439, Math.max(0, Math.round(sessionStartMinutes)));
  sessionEndMinutes = Math.min(1440, Math.max(0, Math.round(sessionEndMinutes)));
  if (sessionStartMinutes >= sessionEndMinutes) {
    sessionEndMinutes = Math.min(1440, sessionStartMinutes + 60);
  }
  return {
    chartType: "scatter",
    xKey,
    yKey,
    xLog: Boolean(raw?.xLog),
    yLog: Boolean(raw?.yLog),
    scatterTimeMode,
    sessionStartMinutes,
    sessionEndMinutes,
    timeBinMinutes,
    timeAgg,
    datasets: dsNorm.slice(0, 8),
  };
}

export function normalizePlotLayout(raw) {
  const base = defaultPlotLayout();
  if (!raw || typeof raw !== "object") return base;
  let gridCount = Number(raw.gridCount);
  if (!Number.isFinite(gridCount))
    gridCount = base.gridCount;
  gridCount = Math.min(12, Math.max(1, Math.round(gridCount)));
  let cols = Number(raw.cols);
  if (!Number.isFinite(cols)) cols = base.cols;
  cols = Math.min(4, Math.max(1, Math.round(cols)));
  const plotsIn = Array.isArray(raw.plots) ? raw.plots : [];
  const plots = [];
  for (let i = 0; i < gridCount; i++) {
    plots.push(clampPlotSlot(plotsIn[i], i));
  }
  return { gridCount, cols, plots };
}

export function readPlotLayoutFromStorage() {
  try {
    const raw = localStorage.getItem(LS_PLOT_LAYOUT);
    if (!raw) return defaultPlotLayout();
    return normalizePlotLayout(JSON.parse(raw));
  } catch {
    return defaultPlotLayout();
  }
}

export function persistPlotLayout(layout) {
  try {
    localStorage.setItem(LS_PLOT_LAYOUT, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

function fieldLabel(id) {
  return PLOT_FIELD_OPTIONS.find((f) => f.id === id)?.label ?? id;
}

/** Open/close axes store Unix epoch milliseconds — chart linear scales must format ticks (not raw 1.77e12). */
function isWallClockMsField(id) {
  return id === "openTs" || id === "closeTs";
}

function formatWallClockMs(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const nowY = new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(d.getFullYear() !== nowY ? { year: "numeric" } : {}),
  });
}

/** Local wall-clock minutes since midnight [0, 1440) from epoch ms. */
function minutesSinceLocalMidnight(epochMs) {
  if (!Number.isFinite(epochMs)) return NaN;
  const d = new Date(epochMs);
  return (
    d.getHours() * 60 +
    d.getMinutes() +
    d.getSeconds() / 60 +
    d.getMilliseconds() / 60000
  );
}

/**
 * Minutes from session open for this trade, or `null` if outside the session window (local clock).
 * X uses this value — no calendar dates.
 */
function epochToSessionOffsetMinutes(epochMs, plot) {
  const dom = minutesSinceLocalMidnight(epochMs);
  const s0 = plot.sessionStartMinutes ?? 7 * 60 + 30;
  const s1 = plot.sessionEndMinutes ?? 15 * 60;
  if (!Number.isFinite(dom) || dom < s0 || dom > s1) return null;
  return dom - s0;
}

/** `<input type="time">` value `HH:MM` from minutes since midnight. */
function minutesToTimeInputValue(mins) {
  const m = (((Math.round(mins) % 1440) + 1440) % 1440);
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Parse `<input type="time">` value to minutes since midnight. Exported for plot control sync. */
export function parseTimeInputToMinutes(s) {
  const t = String(s ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return NaN;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
  if (hh > 23 || mm > 59) return NaN;
  return hh * 60 + mm;
}

function formatTimeOfDayMinutes(m) {
  if (!Number.isFinite(m)) return "";
  const wrap = ((m % 1440) + 1440) % 1440;
  const hh = Math.floor(wrap / 60);
  const mm = Math.floor(wrap % 60);
  const d = new Date(2000, 0, 1, hh, mm, 0);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function scatterAxisTitle(fieldKey, plot) {
  const base = fieldLabel(fieldKey);
  if (plot.scatterTimeMode === "session" && isWallClockMsField(fieldKey)) {
    return `${base} — session (local time, no dates)`;
  }
  return base;
}

/** Single scatter coordinate after calendar vs session mapping. */
function scatterCoordForField(fieldKey, trade, meta, plot) {
  const v = getPlotFieldValue(fieldKey, trade, meta);
  if (!Number.isFinite(v)) return null;
  if (plot.scatterTimeMode === "session" && isWallClockMsField(fieldKey)) {
    return epochToSessionOffsetMinutes(v, plot);
  }
  return v;
}

function scatterTickFormatter(plot, fieldId, v) {
  if (!Number.isFinite(v)) return "";
  if (plot.scatterTimeMode === "session" && isWallClockMsField(fieldId)) {
    const s0 = plot.sessionStartMinutes ?? 7 * 60 + 30;
    return formatTimeOfDayMinutes(s0 + v);
  }
  return tickFormatterForField(fieldId, v);
}

function tooltipScatterAxisValue(plot, fieldId, value) {
  if (!Number.isFinite(value)) return "—";
  if (plot.scatterTimeMode === "session" && isWallClockMsField(fieldId)) {
    const s0 = plot.sessionStartMinutes ?? 7 * 60 + 30;
    return formatTimeOfDayMinutes(s0 + value);
  }
  return tooltipValueForField(fieldId, value);
}

function tickFormatterForField(fieldId, value) {
  if (!Number.isFinite(value)) return "";
  if (isWallClockMsField(fieldId)) return formatWallClockMs(value);
  return String(value);
}

function tooltipValueForField(fieldId, value) {
  if (!Number.isFinite(value)) return "—";
  if (isWallClockMsField(fieldId)) return formatWallClockMs(value);
  if (
    fieldId === "pnl" ||
    fieldId === "totalRisk" ||
    fieldId === "riskPerShare" ||
    fieldId === "twoWayNotional" ||
    fieldId === "mae" ||
    fieldId === "mfe"
  ) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return String(value);
}

function datasetRowHtml(plotSlot, dsIndex, ds, chartType) {
  const tagHint =
    chartType === "histogram"
      ? "Tags (AND): comma or space between tags — import ∪ per-trade, e.g. #scenario3 touch1"
      : "Optional tag filter (AND). Comma or space between tags — empty = all trades in scope above.";
  const sid = `${plotSlot}-${dsIndex}`;
  return `
    <div class="rounded-lg border border-slate-700/80 bg-slate-950/40 p-2 space-y-1.5" data-plot-dataset-row data-ds-index="${dsIndex}">
      <div class="flex flex-wrap gap-2 items-end">
        <div class="min-w-[6rem] flex-1">
          <label class="text-[10px] font-medium text-slate-500">Label</label>
          <input type="text" data-plot-ds-prop="label" value="${escapeHtml(ds.label)}" maxlength="48"
            class="w-full rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200" />
        </div>
        <div class="shrink-0">
          <label class="text-[10px] font-medium text-slate-500">Color</label>
          <input type="color" data-plot-ds-prop="color" value="${escapeHtml(ds.color)}" class="h-9 w-12 cursor-pointer rounded border border-slate-600 bg-slate-900 p-0.5" />
        </div>
        ${
          dsIndex > 0
            ? `<button type="button" data-plot-dataset-remove class="min-h-[36px] px-2 rounded-md text-xs text-loss hover:bg-slate-800/80">Remove</button>`
            : `<span class="w-14 shrink-0" aria-hidden="true"></span>`
        }
      </div>
      <div>
        <label class="text-[10px] font-medium text-slate-500">${tagHint}</label>
        <div class="relative">
          <input type="text" data-plot-ds-prop="tags" data-plot-tag-input autocomplete="off" spellcheck="false"
            data-plot-slot="${plotSlot}" data-ds-index="${dsIndex}"
            value="${escapeHtml(ds.tags)}" placeholder="e.g. strategy1, setupA — fuzzy hints as you type"
            class="plot-tags-input w-full rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 font-mono placeholder:text-slate-600" />
          <div id="plot-tag-suggestions-${sid}" class="plot-tag-suggestions hidden absolute left-0 right-0 top-full z-[90] mt-1 max-h-44 overflow-y-auto rounded-lg border border-slate-600/90 bg-slate-950 py-1 shadow-xl shadow-black/40" role="listbox" aria-label="Tag suggestions"></div>
        </div>
      </div>
    </div>`;
}

function scatterTimeInterpretationHtml(p) {
  const show =
    isWallClockMsField(p.xKey) || isWallClockMsField(p.yKey);
  if (!show) return "";
  const mode =
    p.scatterTimeMode === "session" ? "session" : "calendar";
  const ss = p.sessionStartMinutes ?? 7 * 60 + 30;
  const se = p.sessionEndMinutes ?? 15 * 60;
  const sessionInputs =
    mode === "session"
      ? `
      <div class="grid grid-cols-2 gap-2 mt-2">
        <div>
          <label class="text-[10px] font-medium text-slate-500">Session open (local)</label>
          <input type="time" step="300" data-plot-prop="sessionStartTime" value="${minutesToTimeInputValue(ss)}"
            class="mt-0.5 w-full rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 font-mono" />
        </div>
        <div>
          <label class="text-[10px] font-medium text-slate-500">Session close (local)</label>
          <input type="time" step="300" data-plot-prop="sessionEndTime" value="${minutesToTimeInputValue(se)}"
            class="mt-0.5 w-full rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 font-mono" />
        </div>
      </div>`
      : "";
  return `
    <div class="mt-2 space-y-1">
      <label class="text-[10px] font-medium text-slate-500">Time axis meaning</label>
      <select data-plot-prop="scatterTimeMode" class="select-flat w-full min-h-[34px] rounded-lg border border-slate-700 bg-surface px-2 py-1 text-xs text-slate-200">
        <option value="calendar"${mode === "calendar" ? " selected" : ""}>Calendar — real dates on a timeline</option>
        <option value="session"${mode === "session" ? " selected" : ""}>Session — clock time only (e.g. 7:30am–3pm), date stripped</option>
      </select>
      ${sessionInputs}
      <p class="text-[10px] text-slate-600 leading-snug">Session mode maps each trade&apos;s open/close to <strong class="text-slate-500">minutes from session open</strong> (default U.S. cash window). Trades outside the window are omitted. Y is always the field you pick (e.g. P&amp;L).</p>
    </div>`;
}

function scatterTimeBucketControlsHtml(p) {
  const tbm = p.timeBinMinutes ?? 0;
  const tAgg = p.timeAgg ?? "sum";
  const presetMins = new Set(TIME_BIN_PRESETS.map((x) => x.min));
  const extraBin =
    !presetMins.has(tbm) && tbm > 0
      ? `<option value="${tbm}" selected>${escapeHtml(String(tbm))} min (saved)</option>`
      : "";
  const binOpts =
    TIME_BIN_PRESETS.map(
      ({ min, label }) =>
        `<option value="${min}"${min === tbm ? " selected" : ""}>${escapeHtml(label)}</option>`,
    ).join("") + extraBin;
  return `
    <div class="mt-2 pt-2 border-t border-slate-800/70 space-y-2">
      <p class="text-[10px] text-slate-500 leading-snug">
        <strong class="text-slate-400">Calendar</strong>: buckets are real clock windows on the timeline.
        <strong class="text-slate-400">Session</strong>: buckets are minutes inside your session (e.g. mean P&amp;L per 10&nbsp;min slot from open to close).
      </p>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="text-[10px] font-medium text-slate-500">Time bucket</label>
          <select data-plot-prop="timeBinMinutes" class="select-flat w-full min-h-[34px] rounded-lg border border-slate-700 bg-surface px-2 py-1 text-xs text-slate-200">${binOpts}</select>
        </div>
        <div>
          <label class="text-[10px] font-medium text-slate-500">Aggregate</label>
          <select data-plot-prop="timeAgg" class="select-flat w-full min-h-[34px] rounded-lg border border-slate-700 bg-surface px-2 py-1 text-xs text-slate-200">
            <option value="sum"${tAgg === "sum" ? " selected" : ""}>Sum</option>
            <option value="mean"${tAgg === "mean" ? " selected" : ""}>Mean</option>
            <option value="count"${tAgg === "count" ? " selected" : ""}>Count trades</option>
            <option value="max"${tAgg === "max" ? " selected" : ""}>Max</option>
            <option value="min"${tAgg === "min" ? " selected" : ""}>Min</option>
          </select>
        </div>
      </div>
    </div>`;
}

function plotSlotHtml(layout, index) {
  const p = layout.plots[index];
  const chartType = p.chartType;
  const typeSelect = `
    <div>
      <label class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Chart</label>
      <select data-plot-prop="chartType" class="select-flat w-full min-h-[38px] rounded-lg border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200">
        <option value="scatter"${chartType === "scatter" ? " selected" : ""}>Scatter</option>
        <option value="histogram"${chartType === "histogram" ? " selected" : ""}>Histogram</option>
      </select>
    </div>`;

  const scatterControls =
    chartType === "scatter"
      ? `<div class="grid grid-cols-2 gap-2">
      <div>
        <label class="text-[10px] font-medium text-slate-500">X axis</label>
        ${fieldSelectHtml(p.xKey, "xKey")}
      </div>
      <div>
        <label class="text-[10px] font-medium text-slate-500">Y axis</label>
        ${fieldSelectHtml(p.yKey, "yKey")}
      </div>
    </div>
    <div class="flex flex-wrap gap-4 pt-1">
      <label class="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input type="checkbox" data-plot-prop="xLog" class="rounded border-slate-600" ${p.xLog ? "checked" : ""} />
        Log X
      </label>
      <label class="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input type="checkbox" data-plot-prop="yLog" class="rounded border-slate-600" ${p.yLog ? "checked" : ""} />
        Log Y
      </label>
    </div>
    ${scatterTimeInterpretationHtml(p)}
    ${scatterTimeBucketControlsHtml(p)}`
      : "";

  const histogramControls =
    chartType === "histogram"
      ? `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
      <div class="sm:col-span-1">
        <label class="text-[10px] font-medium text-slate-500">Value</label>
        ${fieldSelectHtml(p.valueKey, "valueKey")}
      </div>
      <div>
        <label class="text-[10px] font-medium text-slate-500">Bins</label>
        <input type="number" data-plot-prop="bins" min="4" max="80" step="1" value="${p.bins}"
          class="w-full rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 font-mono" />
      </div>
      <div>
        <label class="text-[10px] font-medium text-slate-500">Aggregate</label>
        <select data-plot-prop="histAgg" class="select-flat w-full min-h-[38px] rounded-lg border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200">
          <option value="count"${(p.histAgg ?? "count") === "count" ? " selected" : ""}>Count trades</option>
          <option value="sum"${p.histAgg === "sum" ? " selected" : ""}>Sum</option>
          <option value="mean"${p.histAgg === "mean" ? " selected" : ""}>Mean</option>
          <option value="max"${p.histAgg === "max" ? " selected" : ""}>Max</option>
          <option value="min"${p.histAgg === "min" ? " selected" : ""}>Min</option>
        </select>
      </div>
    </div>
    <div class="flex flex-wrap gap-4 pt-1">
      <label class="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input type="checkbox" data-plot-prop="valueLog" class="rounded border-slate-600" ${p.valueLog ? "checked" : ""} />
        Log value (positive only)
      </label>
      <label class="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input type="checkbox" data-plot-prop="freqLog" class="rounded border-slate-600" ${p.freqLog ? "checked" : ""} />
        Log count axis
      </label>
    </div>`
      : "";

  const datasets = p.datasets || [];
  const datasetsBlock = datasets
    .map((ds, j) => datasetRowHtml(index, j, ds, chartType))
    .join("");

  return `
    <div class="rounded-xl border border-slate-800 bg-surface-raised p-3 sm:p-4 flex flex-col min-h-0 min-w-0" data-plot-slot="${index}">
      <div class="flex flex-wrap items-start justify-between gap-2 mb-3">
        <p class="text-xs font-semibold text-slate-400">Plot ${index + 1}</p>
        ${typeSelect}
      </div>
      ${scatterControls}
      ${histogramControls}
      <div class="space-y-2 mt-3 flex-1 min-h-0">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Series</span>
          <button type="button" data-plot-dataset-add class="text-xs text-accent hover:underline">+ Add series</button>
        </div>
        ${datasetsBlock}
      </div>
      <div class="mt-3 h-52 sm:h-64 min-h-[13rem]"><canvas id="plot-canvas-${index}" class="w-full h-full"></canvas></div>
    </div>`;
}

export function buildPlotsExplorerHtml(layout) {
  const gc = layout.gridCount;
  const cols = layout.cols;
  const slots = Array.from({ length: gc }, (_, i) => plotSlotHtml(layout, i)).join("");
  return `
    <section id="plots-explorer" class="space-y-4" aria-labelledby="plots-heading">
      <div class="rounded-xl border border-slate-800 bg-surface-raised px-4 py-3 sm:px-5">
        <h2 id="plots-heading" class="text-sm font-semibold text-white mb-2">Custom plots</h2>
        <p class="text-xs text-slate-500 mb-3">
          Axes match the trades table (time, P&amp;L, result, risk, R:R, …). Use the scope bar above for account + global tags.
          For each series, list tags separated by commas <strong class="text-slate-400">or spaces</strong> — <strong class="text-slate-400">every</strong> listed tag must match (import tags or per-trade tags). Example: <span class="font-mono text-slate-400">#scenario3 touch1</span> is two tags; two comma-separated tags behave the same.
          Compare strategies by giving each series different tag combinations (e.g. <span class="font-mono text-slate-400">ORB, trend</span> vs <span class="font-mono text-slate-400">scalp</span>).
        </p>
        <div class="flex flex-wrap gap-4 items-end">
          <div>
            <label for="plot-grid-count" class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Plots</label>
            <input id="plot-grid-count" type="number" min="1" max="12" value="${gc}"
              class="mt-0.5 w-20 rounded-lg border border-slate-700 bg-surface px-2 py-1.5 text-sm text-slate-200 font-mono" />
          </div>
          <div>
            <label for="plot-grid-cols" class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Columns</label>
            <select id="plot-grid-cols" class="select-flat mt-0.5 min-h-[38px] rounded-lg border border-slate-700 bg-surface px-2 py-1.5 text-sm text-slate-200">
              ${[1, 2, 3, 4]
                .map(
                  (c) =>
                    `<option value="${c}"${c === cols ? " selected" : ""}>${c}</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
      </div>
      <div class="grid gap-4" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr));">
        ${slots}
      </div>
    </section>`;
}

function parseTagsCsv(s) {
  return String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function linSpaceBins(minV, maxV, bins) {
  if (!(maxV > minV)) return { edges: [minV, maxV], labels: ["—"] };
  const edges = [];
  for (let i = 0; i <= bins; i++) {
    edges.push(minV + ((maxV - minV) * i) / bins);
  }
  const labels = [];
  for (let i = 0; i < bins; i++) {
    const a = edges[i];
    const b = edges[i + 1];
    labels.push(`${a.toPrecision(4)}–${b.toPrecision(4)}`);
  }
  return { edges, labels };
}

function logSpaceBins(minV, maxV, bins) {
  const lo = Math.log10(minV);
  const hi = Math.log10(maxV);
  if (!(hi > lo)) return linSpaceBins(minV, maxV, bins);
  const edges = [];
  for (let i = 0; i <= bins; i++) {
    edges.push(10 ** (lo + ((hi - lo) * i) / bins));
  }
  const labels = [];
  for (let i = 0; i < bins; i++) {
    labels.push(`${edges[i].toPrecision(3)}–${edges[i + 1].toPrecision(3)}`);
  }
  return { edges, labels };
}

function binAggregateValues(values, edges, agg) {
  const n = edges.length - 1;
  const buckets = Array.from({ length: n }, () => []);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    for (let i = 0; i < n; i++) {
      const left = edges[i];
      const right = edges[i + 1];
      const last = i === n - 1;
      const inBin = last ? v >= left && v <= right : v >= left && v < right;
      if (inBin) {
        buckets[i].push(v);
        break;
      }
    }
  }
  const aggNorm = String(agg ?? "count").toLowerCase();
  const bars = [];
  const binTradeCounts = [];
  for (const vals of buckets) {
    binTradeCounts.push(vals.length);
    if (aggNorm === "count") {
      bars.push(vals.length);
    } else if (!vals.length) {
      bars.push(0);
    } else if (aggNorm === "sum") {
      bars.push(vals.reduce((a, b) => a + b, 0));
    } else if (aggNorm === "mean") {
      bars.push(vals.reduce((a, b) => a + b, 0) / vals.length);
    } else if (aggNorm === "max") {
      bars.push(Math.max(...vals));
    } else if (aggNorm === "min") {
      bars.push(Math.min(...vals));
    } else {
      bars.push(vals.length);
    }
  }
  return { bars, binTradeCounts };
}

function histogramFreqAxisTitle(plot, freqLogEffective /* optional override */) {
  const agg = String(plot.histAgg ?? "count").toLowerCase();
  const vl = fieldLabel(plot.valueKey);
  const logFx =
    freqLogEffective !== undefined ? freqLogEffective : Boolean(plot.freqLog);
  const logSfx = logFx ? " (log)" : "";
  if (agg === "count") return logFx ? `Count${logSfx}` : "Count";
  if (agg === "sum") return `Sum · ${vl}${logSfx}`;
  if (agg === "mean") return `Mean · ${vl}${logSfx}`;
  if (agg === "max") return `Max · ${vl}${logSfx}`;
  if (agg === "min") return `Min · ${vl}${logSfx}`;
  return logFx ? `Count${logSfx}` : "Count";
}

function scatterScaleLogs(plot) {
  const binMin = Number(plot.timeBinMinutes) || 0;
  const binMs = binMin * 60 * 1000;
  const timeOnX = isWallClockMsField(plot.xKey);
  const timeOnY = isWallClockMsField(plot.yKey);
  const domX = plot.scatterTimeMode === "session" && timeOnX;
  const domY = plot.scatterTimeMode === "session" && timeOnY;
  const useTimeBucket =
    binMin > 0 && binMs > 0 && (timeOnX || timeOnY);

  let xLog = domX ? false : plot.xLog;
  let yLog = domY ? false : plot.yLog;
  if (useTimeBucket) {
    if (timeOnX && !domX) xLog = false;
    if (timeOnY && !domY) yLog = false;
  }
  return { xLog, yLog };
}

function buildScatterPointsForDataset(rows, plot, getMeta) {
  const binMin = Number(plot.timeBinMinutes) || 0;
  const binMs = binMin * 60 * 1000;
  const agg = (plot.timeAgg || "sum").toLowerCase();
  const timeOnX = isWallClockMsField(plot.xKey);
  const timeOnY = isWallClockMsField(plot.yKey);
  const useTimeBucket =
    binMin > 0 && binMs > 0 && (timeOnX || timeOnY);

  if (!useTimeBucket) {
    const pts = [];
    const { xLog: xl, yLog: yl } = scatterScaleLogs(plot);
    for (const t of rows) {
      const meta = getMeta(t.id);
      const x = scatterCoordForField(plot.xKey, t, meta, plot);
      const y = scatterCoordForField(plot.yKey, t, meta, plot);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (xl && x <= 0) continue;
      if (yl && y <= 0) continue;
      pts.push({
        x,
        y,
        _sym: t.symbol,
        _dk: t.dateKey,
        _agg: false,
      });
    }
    return pts;
  }

  const binOnX = timeOnX || !timeOnY;
  const timeField = binOnX ? plot.xKey : plot.yKey;
  const valueField = binOnX ? plot.yKey : plot.xKey;
  const timeSession =
    plot.scatterTimeMode === "session" && isWallClockMsField(timeField);
  const groups = new Map();

  for (const t of rows) {
    const meta = getMeta(t.id);
    const tMs = getPlotFieldValue(timeField, t, meta);
    if (!Number.isFinite(tMs)) continue;

    let bucket;
    if (timeSession) {
      const off = epochToSessionOffsetMinutes(tMs, plot);
      if (off == null || !Number.isFinite(off)) continue;
      bucket = Math.floor(off / binMin) * binMin;
    } else {
      bucket = Math.floor(tMs / binMs) * binMs;
    }

    const val = getPlotFieldValue(valueField, t, meta);
    if (agg !== "count" && !Number.isFinite(val)) continue;

    if (!groups.has(bucket)) {
      groups.set(bucket, { vals: [], count: 0 });
    }
    const g = groups.get(bucket);
    g.count += 1;
    if (agg !== "count" && Number.isFinite(val)) g.vals.push(val);
  }

  const pts = [];
  const keys = [...groups.keys()].sort((a, b) => a - b);
  for (const bucket of keys) {
    const g = groups.get(bucket);
    let metric;
    if (agg === "count") {
      metric = g.count;
    } else {
      if (!g.vals.length) continue;
      const vs = g.vals;
      if (agg === "sum") {
        metric = vs.reduce((a, b) => a + b, 0);
      } else if (agg === "mean") {
        metric = vs.reduce((a, b) => a + b, 0) / vs.length;
      } else if (agg === "max") {
        metric = Math.max(...vs);
      } else if (agg === "min") {
        metric = Math.min(...vs);
      } else {
        metric = vs.reduce((a, b) => a + b, 0);
      }
    }
    const x = binOnX ? bucket : metric;
    const y = binOnX ? metric : bucket;
    pts.push({
      x,
      y,
      _sym: "",
      _dk: "",
      _agg: true,
      _n: g.count,
    });
  }

  return pts;
}

function sessionSpanMinutes(plot) {
  const s0 = plot.sessionStartMinutes ?? 7 * 60 + 30;
  const s1 = plot.sessionEndMinutes ?? 15 * 60;
  return Math.max(1, s1 - s0);
}

function paintScatter(canvas, tradesByDataset, plot, getMeta) {
  destroyChart(canvas);
  const { xLog, yLog } = scatterScaleLogs(plot);
  const domX =
    plot.scatterTimeMode === "session" && isWallClockMsField(plot.xKey);
  const domY =
    plot.scatterTimeMode === "session" && isWallClockMsField(plot.yKey);
  const span = sessionSpanMinutes(plot);

  const datasets = plot.datasets.map((ds, di) => {
    const rows = tradesByDataset[di] || [];
    const pts = buildScatterPointsForDataset(rows, plot, getMeta);
    return {
      label: ds.label || `Series ${di + 1}`,
      data: pts,
      backgroundColor: ds.color + "99",
      borderColor: ds.color,
      pointRadius: 4,
      pointHoverRadius: 6,
    };
  });

  return new Chart(canvas, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const raw = ctx.raw;
              const px = ctx.parsed.x;
              const py = ctx.parsed.y;
              let xStr = tooltipScatterAxisValue(plot, plot.xKey, px);
              let yStr = tooltipScatterAxisValue(plot, plot.yKey, py);
              if (raw?._agg && plot.timeAgg === "count") {
                const tx = isWallClockMsField(plot.xKey);
                const ty = isWallClockMsField(plot.yKey);
                if (!tx) xStr = String(Math.round(px));
                if (!ty) yStr = String(Math.round(py));
              }
              const sym = raw?._sym ?? "";
              const dk = raw?._dk ?? "";
              const binNote =
                raw?._agg && raw?._n != null
                  ? ` · ${raw._n} trade${raw._n === 1 ? "" : "s"} in bucket`
                  : "";
              return `${ctx.dataset.label}: x=${xStr} · y=${yStr}${binNote}${sym ? ` · ${sym}` : ""}${dk ? ` · ${dk}` : ""}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: xLog ? "logarithmic" : "linear",
          title: { display: true, text: scatterAxisTitle(plot.xKey, plot) },
          grid: { color: grid },
          suggestedMin: domX ? 0 : undefined,
          suggestedMax: domX ? span : undefined,
          ticks: {
            maxRotation: domX ? 0 : 45,
            minRotation: 0,
            callback: (v) => scatterTickFormatter(plot, plot.xKey, v),
          },
        },
        y: {
          type: yLog ? "logarithmic" : "linear",
          title: { display: true, text: scatterAxisTitle(plot.yKey, plot) },
          grid: { color: grid },
          suggestedMin: domY ? 0 : undefined,
          suggestedMax: domY ? span : undefined,
          ticks: {
            callback: (v) => scatterTickFormatter(plot, plot.yKey, v),
          },
        },
      },
    },
  });
}

function paintHistogram(canvas, seriesValues, plot) {
  destroyChart(canvas);
  const valueKey = plot.valueKey;
  const bins = plot.bins;
  const histAgg = String(plot.histAgg ?? "count").toLowerCase();
  /** Log scale only safe for positive counts; sum/mean of value can be negative. */
  const freqLogAxis = Boolean(plot.freqLog) && histAgg === "count";
  const allVals = seriesValues.flatMap((a) => a);
  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of allVals) {
    if (!Number.isFinite(v)) continue;
    if (plot.valueLog && v <= 0) continue;
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  if (!Number.isFinite(minV) || !(maxV > minV)) {
    return new Chart(canvas, {
      type: "bar",
      data: {
        labels: ["No data"],
        datasets: [{ label: "—", data: [0], backgroundColor: "rgba(148,163,184,0.35)" }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  }

  const { edges, labels } = plot.valueLog
    ? logSpaceBins(minV, maxV, bins)
    : linSpaceBins(minV, maxV, bins);

  const datasets = plot.datasets.map((ds, di) => {
    const vals = seriesValues[di] || [];
    const filtered = plot.valueLog
      ? vals.filter((v) => Number.isFinite(v) && v > 0)
      : vals.filter((v) => Number.isFinite(v));
    const { bars, binTradeCounts } = binAggregateValues(
      filtered,
      edges,
      plot.histAgg,
    );
    return {
      label: ds.label || `Series ${di + 1}`,
      data: bars,
      binTradeCounts,
      backgroundColor: (ds.color || "#94a3b8") + "aa",
      borderColor: ds.color || "#94a3b8",
      borderWidth: 1,
    };
  });

  return new Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => labels[items[0]?.dataIndex] ?? "",
            label: (ctx) => {
              const ds = ctx.dataset;
              const idx = ctx.dataIndex;
              const y = ctx.parsed.y;
              const lab = ds.label || "";
              const n = ds.binTradeCounts?.[idx];
              if (histAgg === "count") return `${lab}: ${y}`;
              const valStr = tooltipValueForField(valueKey, y);
              const nc =
                n != null
                  ? ` · ${n} trade${n === 1 ? "" : "s"} in bin`
                  : "";
              return `${lab}: ${valStr}${nc}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: false,
          ticks: { maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid: { color: grid },
        },
        y: {
          type: freqLogAxis ? "logarithmic" : "linear",
          beginAtZero: true,
          title: {
            display: true,
            text: histogramFreqAxisTitle(plot, freqLogAxis),
          },
          grid: { color: grid },
        },
      },
    },
  });
}

/**
 * @param {HTMLElement | null} root
 * @param {object[]} tradesScoped full trades after account + dashboard tag scope
 * @param {object} layout normalized layout
 * @param {(trade: object, tagsCsv: string) => object[]} filterTradesForTags
 * @param {(id: string) => object} getMeta
 */
export function paintPlotExplorer(root, tradesScoped, layout, filterTradesForTags, getMeta) {
  if (!root) return;
  for (let i = 0; i < layout.gridCount; i++) {
    const cv = document.getElementById(`plot-canvas-${i}`);
    if (cv) destroyChart(cv);
  }

  for (let i = 0; i < layout.plots.length; i++) {
    const canvas = document.getElementById(`plot-canvas-${i}`);
    const plot = layout.plots[i];
    if (!canvas || !plot) continue;

    const tradesByDataset = plot.datasets.map((ds) =>
      filterTradesForTags(tradesScoped, ds.tags),
    );

    if (plot.chartType === "scatter") {
      paintScatter(canvas, tradesByDataset, plot, getMeta);
    } else {
      const seriesValues = tradesByDataset.map((arr) =>
        arr
          .map((t) => getPlotFieldValue(plot.valueKey, t, getMeta(t.id)))
          .filter((v) => Number.isFinite(v)),
      );
      paintHistogram(canvas, seriesValues, plot);
    }
  }
}
