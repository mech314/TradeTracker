import "./style.css";
import { isPasswordRecovery } from "./reset-password.js";
import {
  extractFillsAndBalances,
  buildRoundTripTrades,
  buildEquitySeries,
} from "./engine.js";
import { coerceNumber } from "./csv.js";
import {
  computeMetrics,
  formatPct,
  formatUsd,
  canonicalDateKey,
} from "./metrics.js";
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
import { 
  isLoggedIn, 
  login, 
  register, 
  logout } 
  from "./auth.js";
import {
  apiGetAllMeta,
  apiUpsertMeta,
  apiDeleteMeta,
  apiUploadScreenshot,
  apiUpsertTrades,
  apiGetTrades,
  apiDeleteTrade,
  apiChangePassword,
  apiDeleteAllTrades,
  apiDeleteAccount,
  apiUpsertBalance,
  apiGetBalance,
  apiCreateImport,
  apiGetImports,
  apiUpdateImportTags,
  apiGetAccounts,
  apiCreateTradingAccount,
  apiDeleteTradingAccount,
  apiBackfillTradingAccounts,
  apiGetDayNotes,
  apiPutDayNote,
} from "./api.js";
import Fuse from "fuse.js";

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
        <button id="auth-forgot-btn"
          class="w-full text-sm text-slate-500 hover:text-slate-300 transition-colors">
          Forgot password?
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

  document.querySelector("#auth-forgot-btn")?.addEventListener("click", async () => {
    const emailVal = email();
    if (!emailVal) {
      msg().textContent = "Enter your email first";
      msg().classList.remove("hidden");
      return;
    }
    try {
      await fetch(`/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailVal })
      });
      msg().textContent = "Check your email for a recovery link";
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

/** Route ids for `state.page` — use these instead of string literals. */
const Page = Object.freeze({
  Account: "account",
  Dashboard: "dashboard",
  Calendar: "calendar",
  TradeImport: "trade-import",
});

const ALL_PAGE_IDS = Object.freeze(Object.values(Page));

const LS_UPLOAD_ACCOUNT = "tradetracker_upload_account_id";
const LS_DISPLAY_ACCOUNT = "tradetracker_display_account_id";
const LS_DASHBOARD_TAGS = "tradetracker_dashboard_tags";
const LS_TRADE_TABLE_SORT = "tradetracker_trades_table_sort";
const LS_CALENDAR_DAY_NOTES = "tradetracker_calendar_day_notes";

function readCalendarDayNotesFromStorage() {
  try {
    const raw = localStorage.getItem(LS_CALENDAR_DAY_NOTES);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const out = {};
        for (const [k, v] of Object.entries(j)) {
          const ck = canonicalDateKey(k);
          if (!ck || typeof v !== "string") continue;
          const t = v.trim();
          if (t) out[ck] = v;
        }
        return out;
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}

function persistCalendarDayNotes() {
  try {
    localStorage.setItem(
      LS_CALENDAR_DAY_NOTES,
      JSON.stringify(state.calendarDayNotes),
    );
  } catch {
    /* ignore */
  }
}

/** Columns that support header / mobile sorting on the calendar trades table. */
const TRADE_TABLE_SORT_COLUMNS = new Set([
  "dateKey",
  "openTs",
  "closeTs",
  "symbol",
  "openSide",
  "maxShares",
  "riskPerShare",
  "totalRisk",
  "rr",
  "pnl",
  "result",
  "notesMeta",
]);

function readTradeTableSortFromStorage() {
  try {
    const raw = localStorage.getItem(LS_TRADE_TABLE_SORT);
    if (raw) {
      const j = JSON.parse(raw);
      if (
        j &&
        typeof j.column === "string" &&
        TRADE_TABLE_SORT_COLUMNS.has(j.column) &&
        (j.direction === "asc" || j.direction === "desc")
      ) {
        return { column: j.column, direction: j.direction };
      }
    }
  } catch {
    /* ignore */
  }
  return { column: "closeTs", direction: "desc" };
}

function persistTradeTableSort() {
  try {
    localStorage.setItem(
      LS_TRADE_TABLE_SORT,
      JSON.stringify(state.tradeTableSort),
    );
  } catch {
    /* ignore */
  }
}

function defaultTradeSortDirection(column) {
  if (column === "symbol" || column === "openSide" || column === "notesMeta") {
    return "asc";
  }
  return "desc";
}

function readDashboardTagFiltersFromStorage() {
  try {
    const raw = localStorage.getItem(LS_DASHBOARD_TAGS);
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) {
        return [
          ...new Set(
            j.map((x) => String(x).trim()).filter(Boolean),
          ),
        ];
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

function persistDashboardTagFilters() {
  try {
    localStorage.setItem(
      LS_DASHBOARD_TAGS,
      JSON.stringify(state.dashboardTagFilters),
    );
  } catch {
    /* ignore */
  }
}

function isActivePage(id) {
  return state.page === id;
}

let state = {
  trades: [],
  metrics: null,
  /** Balance rows from DB or last CSV import; used for equity + tag filter. */
  balanceSnapshots: [],
  /** User import records (includes `tags`); from GET /api/imports. */
  imports: [],
  /** Named accounts (label + broker); from GET /api/accounts. */
  tradingAccounts: [],
  /** CSV uploads are linked to this trading_accounts row. */
  uploadAccountId: localStorage.getItem(LS_UPLOAD_ACCOUNT) ?? "",
  /** Dashboard + calendar scope: "" = all accounts, else trading_accounts id. */
  displayAccountId: localStorage.getItem(LS_DISPLAY_ACCOUNT) ?? "",
  /** Dashboard + calendar: filter to imports that have any of these strategy tags (OR). */
  dashboardTagFilters: readDashboardTagFiltersFromStorage(),
  filesLabel: "No files loaded",
  /** Set when CSVs are loaded: used to refresh the status line after deleting trades. */
  fileLoadInfo: null,
  calendarMonth: new Date(),
  selectedDay: null,
  detailTrade: null,
  tradeMetaById: new Map(),
  screenshotUrls: new Map(),
  page: Page.Dashboard,
  /** Calendar year for dashboard P&amp;L heatmap (Mon–Fri). */
  pnlHeatmapYear: new Date().getFullYear(),
  /** Calendar trades table: column id + asc/desc (persisted). */
  tradeTableSort: readTradeTableSortFromStorage(),
  /** Per calendar day (YYYY-MM-DD) free-form notes; localStorage only. */
  calendarDayNotes: readCalendarDayNotesFromStorage(),
};

let metaPopoverHideTimer = null;
let metaPopoverAnchor = null;
let metaPopoverDocumentCloseBound = false;
let modalScreenshotExplicitlyCleared = false;
let tradeMenuTradeId = null;
let dashboardTagSuggestHighlight = -1;
let dashboardTagBlurHideTimer = null;

/** Normalize `imports.tags` from API (array, JSON string, comma-separated string, or array-like object). */
function importTagsAsArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "object" && raw !== null) {
    const keys = Object.keys(raw).filter((k) => /^\d+$/.test(k));
    if (keys.length) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => String(raw[k]).trim())
        .filter(Boolean);
    }
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) {
          return j.map((x) => String(x).trim()).filter(Boolean);
        }
      } catch {
        /* fall through */
      }
    }
    return s.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function uniqueSortedTagsFromImports(imports) {
  const set = new Set();
  for (const im of imports || []) {
    for (const t of importTagsAsArray(im.tags)) {
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function tradeMetaTagsNormalized(meta) {
  const raw = meta?.tags;
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return [
      ...new Set(raw.map((x) => String(x).trim()).filter(Boolean)),
    ];
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) {
          return tradeMetaTagsNormalized({ tags: j });
        }
      } catch {
        /* fall through */
      }
    }
    return [
      ...new Set(s.split(",").map((t) => t.trim()).filter(Boolean)),
    ];
  }
  return [];
}

/** Import tags ∪ per-trade meta tags (account-scoped trades), sorted. */
function mergedDashboardTagOptions(importsScope, accountScopedTrades) {
  const set = new Set(uniqueSortedTagsFromImports(importsScope));
  for (const t of accountScopedTrades || []) {
    const m = state.tradeMetaById.get(t.id);
    for (const tag of tradeMetaTagsNormalized(m)) {
      set.add(tag);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Canonical form for comparing import UUIDs from DB vs API (case / whitespace). */
function normImportId(v) {
  if (v == null || v === "") return "";
  return String(v).trim().toLowerCase();
}

/**
 * Normalized key for tag equality (dashboard filters, import vs per-trade tags).
 * Trims, lowercases, strips leading `#` so `#9EMA` and `9EMA` match.
 */
function tagKeyForMatch(s) {
  let t = String(s ?? "").trim().toLowerCase();
  while (t.startsWith("#")) {
    t = t.slice(1).trim();
  }
  return t;
}

function importIdsForTradingAccount(imports, accountId) {
  const want = normImportId(accountId);
  if (!want) return null;
  const set = new Set();
  for (const im of imports || []) {
    if (normImportId(im.account_id) === want) {
      const iid = normImportId(im.id);
      if (iid) set.add(iid);
    }
  }
  return set;
}

function filteredTradesByAccount(trades, imports, accountId) {
  const set = importIdsForTradingAccount(imports, accountId);
  if (set == null) return trades || [];
  return (trades || []).filter((t) => set.has(normImportId(t.importId)));
}

function importsInDisplayScope(imports, accountId) {
  const want = normImportId(accountId);
  if (!want) return imports || [];
  return (imports || []).filter(
    (im) => normImportId(im.account_id) === want,
  );
}

function dashboardScope() {
  const importsScope = importsInDisplayScope(
    state.imports,
    state.displayAccountId,
  );
  const baseTrades = filteredTradesByAccount(
    state.trades,
    state.imports,
    state.displayAccountId,
  );
  const tradesView = filteredTradesByTagsAny(
    baseTrades,
    importsScope,
    state.dashboardTagFilters,
  );
  return { importsScope, baseTrades, tradesView };
}

function syncTradingAccountPickerState() {
  const ids = new Set(
    (state.tradingAccounts || []).map((a) => normImportId(a.id)),
  );
  if (state.uploadAccountId && !ids.has(normImportId(state.uploadAccountId))) {
    state.uploadAccountId = "";
    localStorage.removeItem(LS_UPLOAD_ACCOUNT);
  }
  if (state.displayAccountId && !ids.has(normImportId(state.displayAccountId))) {
    state.displayAccountId = "";
    localStorage.removeItem(LS_DISPLAY_ACCOUNT);
  }
}

function tradingAccountById(id) {
  const w = normImportId(id);
  return (state.tradingAccounts || []).find(
    (a) => normImportId(a.id) === w,
  );
}

function countImportsForTradingAccount(accountId) {
  const w = normImportId(accountId);
  return (state.imports || []).filter((im) => normImportId(im.account_id) === w)
    .length;
}

/** Stored `broker` uses compact codes (e.g. ToS); UI shows the same names as the add-account dropdown. */
function brokerDisplayName(code) {
  if (code == null || code === "") return "";
  const s = String(code).trim();
  const byExact = {
    Schwab: "Schwab",
    ToS: "ThinkOrSwim",
    Webull: "Webull",
    Other: "Other",
  };
  if (Object.prototype.hasOwnProperty.call(byExact, s)) return byExact[s];
  const lower = s.toLowerCase();
  if (lower === "tos" || lower === "thinkorswim") return "ThinkOrSwim";
  if (lower === "schwab") return "Schwab";
  if (lower === "webull") return "Webull";
  if (lower === "other") return "Other";
  return s;
}

function brokerPlatformSelectHtml(idAttr, selected) {
  const sel = (v) => (v === selected ? " selected" : "");
  return `<select id="${idAttr}" class="select-flat w-full min-h-[40px] rounded-lg border border-slate-700 bg-surface px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent/80">
          <option value="Schwab"${sel("Schwab")}>Schwab</option>
          <option value="ToS"${sel("ToS")}>ThinkOrSwim</option>
          <option value="Webull"${sel("Webull")}>Webull</option>
          <option value="Other"${sel("Other")}>Other</option>
        </select>`;
}

/**
 * Dashboard tag chips use **AND**: every selected tag must appear on the trade’s
 * import tags and/or that same trade’s meta tags (union), case-insensitive.
 * Matching uses {@link tagKeyForMatch} so `#ORB` and `ORB` are the same.
 */
function tradeMatchesAllDashboardTags(trade, importsScope, wantMatchKeys) {
  if (!wantMatchKeys.length) return true;
  const pid = normImportId(trade.importId);
  const keys = [];
  if (pid) {
    const im = (importsScope || []).find(
      (row) => normImportId(row.id) === pid,
    );
    if (im) {
      for (const x of importTagsAsArray(im.tags)) {
        const k = tagKeyForMatch(x);
        if (k) keys.push(k);
      }
    }
  }
  const meta = state.tradeMetaById.get(trade.id);
  for (const x of tradeMetaTagsNormalized(meta)) {
    const k = tagKeyForMatch(x);
    if (k) keys.push(k);
  }
  const combined = new Set(keys);
  return wantMatchKeys.every((w) => combined.has(w));
}

/** Tags from the CSV import row linked to this trade. */
function importTagsForTrade(trade) {
  const pid = normImportId(trade?.importId);
  if (!pid) return [];
  const im = (state.imports || []).find(
    (row) => normImportId(row.id) === pid,
  );
  return im ? importTagsAsArray(im.tags) : [];
}

/** Trim, drop empties, dedupe case-insensitively (keep first spelling). */
function normalizeTradeTagList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function renderModalTradeTagChips() {
  const wrap = $("#modal-trade-tags-chips");
  if (!wrap) return;
  const tags = normalizeTradeTagList(modalTradeTagsDraft);
  modalTradeTagsDraft = [...tags];
  if (!tags.length) {
    wrap.innerHTML = `<span class="text-xs text-slate-500 italic">No per-trade tags yet — add one below.</span>`;
    return;
  }
  wrap.innerHTML = tags
    .map(
      (tg) =>
        `<span class="inline-flex items-center gap-0.5 rounded-md border border-violet-500/35 bg-violet-500/15 pl-2 pr-0.5 py-0.5 text-[11px] text-violet-100 max-w-full min-w-0">
    <span class="min-w-0 truncate">${escapeHtml(tg)}</span>
    <button type="button" class="modal-trade-tag-remove shrink-0 rounded p-1 text-slate-400 hover:text-white hover:bg-white/10 min-h-[28px] min-w-[28px] flex items-center justify-center" data-remove-tag="${encodeURIComponent(tg)}" aria-label="Remove tag ${escapeAttr(tg)}">×</button>
  </span>`,
    )
    .join("");
}

function addModalTradeTagFromInput() {
  const inp = $("#modal-trade-tag-add");
  if (!inp) return;
  const raw = String(inp.value || "").trim();
  if (!raw) return;
  const tag = raw.replace(/\s+/g, " ");
  const lc = tag.toLowerCase();
  const tags = normalizeTradeTagList(modalTradeTagsDraft);
  if (tags.some((t) => t.toLowerCase() === lc)) {
    inp.value = "";
    return;
  }
  tags.push(tag);
  modalTradeTagsDraft = tags;
  inp.value = "";
  renderModalTradeTagChips();
}

let modalImportEditId = null;
/** Import-level tags while trade modal is open (saved on Save). */
let modalImportTagsDraft = [];

function renderModalImportTagChips() {
  const wrap = $("#modal-import-tags-chips");
  const addRow = $("#modal-import-tags-add-row");
  if (!wrap) return;
  if (!modalImportEditId) {
    wrap.innerHTML = `<span class="text-xs text-slate-500 italic">No import linked — import tags apply to trades loaded from a CSV upload with an import id.</span>`;
    if (addRow) addRow.classList.add("hidden");
    return;
  }
  if (addRow) addRow.classList.remove("hidden");
  const tags = normalizeTradeTagList(modalImportTagsDraft);
  modalImportTagsDraft = [...tags];
  if (!tags.length) {
    wrap.innerHTML = `<span class="text-xs text-slate-500 italic">No import tags yet — add one below.</span>`;
    return;
  }
  wrap.innerHTML = tags
    .map(
      (tg) =>
        `<span class="inline-flex items-center gap-0.5 rounded-md border border-amber-500/35 bg-amber-500/15 pl-2 pr-0.5 py-0.5 text-[11px] text-amber-100 max-w-full min-w-0">
    <span class="min-w-0 truncate">${escapeHtml(tg)}</span>
    <button type="button" class="modal-import-tag-remove shrink-0 rounded p-1 text-slate-400 hover:text-white hover:bg-white/10 min-h-[28px] min-w-[28px] flex items-center justify-center" data-remove-import-tag="${encodeURIComponent(tg)}" aria-label="Remove import tag ${escapeAttr(tg)}">×</button>
  </span>`,
    )
    .join("");
}

function addModalImportTagFromInput() {
  if (!modalImportEditId) return;
  const inp = $("#modal-import-tag-add");
  if (!inp) return;
  const raw = String(inp.value || "").trim();
  if (!raw) return;
  const tag = raw.replace(/\s+/g, " ");
  const lc = tag.toLowerCase();
  const tags = normalizeTradeTagList(modalImportTagsDraft);
  if (tags.some((t) => t.toLowerCase() === lc)) {
    inp.value = "";
    return;
  }
  tags.push(tag);
  modalImportTagsDraft = tags;
  inp.value = "";
  renderModalImportTagChips();
}

function filteredTradesByTagsAny(trades, imports, tags) {
  const want = Array.isArray(tags)
    ? [
        ...new Set(tags.map((t) => String(t).trim()).filter(Boolean)),
      ]
    : [];
  if (!want.length) return trades || [];
  const wantMatchKeys = want
    .map((t) => tagKeyForMatch(t))
    .filter(Boolean);
  if (!wantMatchKeys.length) return trades || [];
  return (trades || []).filter((tr) =>
    tradeMatchesAllDashboardTags(tr, imports, wantMatchKeys),
  );
}

/** Balance rows for imports that still appear in this trade subset (used when tag filters are on). */
function filteredBalanceSnapshotsForTradesSubset(snapshots, tradesSubset) {
  const ids = new Set();
  for (const t of tradesSubset || []) {
    const p = normImportId(t.importId);
    if (p) ids.add(p);
  }
  const snaps = snapshots || [];
  if (!ids.size) {
    return snaps.filter((s) => normImportId(s.importId) === "");
  }
  return snaps.filter((s) => {
    const p = normImportId(s.importId);
    return p === "" || ids.has(p);
  });
}

function filteredBalanceSnapshotsByAccount(snapshots, imports, accountId) {
  const set = importIdsForTradingAccount(imports, accountId);
  if (set == null) return snapshots || [];
  return (snapshots || []).filter((s) => set.has(normImportId(s.importId)));
}

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

/** API / DB may return `2025-12-03` or ISO timestamps; month filters assume `YYYY-MM-DD`. */
function normalizeDateKey(k) {
  if (k == null) return "";
  const s = String(k);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/**
 * Balance snapshots for the calendar month, with carry-forward so the line chart
 * always has a path (strict date-in-month filtering often yields [] because CSV
 * balance rows are sparse).
 */
function equitySeriesForMonth(series, y, mo) {
  const { start, end } = monthDateKeyRange(y, mo);
  const pts = series
    .map((p) => ({
      dateKey: normalizeDateKey(p.dateKey),
      balance: coerceNumber(p.balance),
    }))
    .filter((p) => p.dateKey && p.balance != null);
  pts.sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const inMonth = pts.filter((p) => p.dateKey >= start && p.dateKey <= end);
  const before = pts.filter((p) => p.dateKey < start);
  const prior = before.length ? before[before.length - 1] : null;

  if (inMonth.length === 0) {
    if (!prior) return [];
    return [
      { dateKey: start, balance: prior.balance },
      { dateKey: end, balance: prior.balance },
    ];
  }

  const out = [];
  const firstIn = inMonth[0];
  const openBal =
    prior && firstIn.dateKey > start
      ? prior.balance
      : firstIn.balance;
  if (firstIn.dateKey > start) {
    out.push({ dateKey: start, balance: openBal });
  }
  for (const p of inMonth) {
    if (out.length && out[out.length - 1].dateKey === p.dateKey) continue;
    out.push({ dateKey: p.dateKey, balance: p.balance });
  }
  const last = out[out.length - 1];
  if (last.dateKey < end) {
    out.push({ dateKey: end, balance: last.balance });
  }
  return out;
}

function tradesClosedInMonth(trades, y, mo) {
  return trades.filter((t) => {
    const dk = canonicalDateKey(t.dateKey);
    if (!dk) return false;
    const parts = dk.split("-").map(Number);
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
    const k = canonicalDateKey(t.dateKey);
    if (!k) continue;
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

function dateKeyYear(dk) {
  if (dk == null || typeof dk !== "string") return null;
  const y = Number(dk.slice(0, 4));
  return Number.isFinite(y) ? y : null;
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

/** Each Monday whose Mon–Fri range intersects the calendar year `y`. */
function weekMondaysOverlappingYear(y) {
  const jan1 = new Date(y, 0, 1);
  const dec31 = new Date(y, 11, 31);
  let mon = mondayOnOrBefore(jan1);
  const list = [];
  for (let guard = 0; guard < 55; guard++) {
    const fri = addDays(mon, 4);
    if (fri >= jan1 && mon <= dec31) list.push(new Date(mon));
    mon = addDays(mon, 7);
    if (mon > addDays(dec31, 6)) break;
  }
  return list;
}

function pnlHeatmapYearOptions(trades) {
  const cy = new Date().getFullYear();
  let minY = cy;
  for (const t of trades) {
    const yy = dateKeyYear(t.dateKey);
    if (yy != null) minY = Math.min(minY, yy);
  }
  const years = [];
  for (let yy = cy; yy >= minY; yy--) years.push(yy);
  return years.length ? years : [cy];
}

/** Per-trade stats for round trips whose `dateKey` (close day) falls in `year`. */
function pnlTradeStatsForYear(trades, year) {
  const inYear = trades.filter((t) => dateKeyYear(t.dateKey) === year);
  const winPnls = inYear
    .filter((t) => Number.isFinite(t.pnl) && t.pnl > 0)
    .map((t) => t.pnl);
  const lossPnls = inYear
    .filter((t) => Number.isFinite(t.pnl) && t.pnl < 0)
    .map((t) => t.pnl);
  return {
    biggestWinner: winPnls.length ? Math.max(...winPnls) : null,
    biggestLoser: lossPnls.length ? Math.min(...lossPnls) : null,
    avgWinner: winPnls.length
      ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length
      : null,
    avgLoser: lossPnls.length
      ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length
      : null,
  };
}

/** Max / min daily net P&amp;L among `byDayPnl` keys in `year` (days with at least one counted close). */
function pnlDayBestWorstForYear(map, year) {
  let bestDay = null;
  let worstDay = null;
  for (const [dk, v] of map) {
    if (dateKeyYear(dk) !== year || !Number.isFinite(v)) continue;
    if (bestDay === null || v > bestDay) bestDay = v;
    if (worstDay === null || v < worstDay) worstDay = v;
  }
  return { bestDay, worstDay };
}

/**
 * GitHub-style grid for one calendar year: Mon–Fri only (5 rows), columns = weeks overlapping that year.
 * `byDayPnl`: dateKey → net P&amp;L for that day (same keys as `computeMetrics`).
 */
function renderPnlHeatmapSectionHtml(byDayPnl, trades, year, yearOptions) {
  const map = byDayPnl instanceof Map ? byDayPnl : new Map();
  const y = year;
  const opts = Array.isArray(yearOptions) && yearOptions.length ? yearOptions : [y];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cy = today.getFullYear();
  const weekMons = weekMondaysOverlappingYear(y);

  let maxAbs = 0;
  for (const mon of weekMons) {
    for (let r = 0; r < 5; r++) {
      const d = addDays(mon, r);
      if (d.getFullYear() !== y) continue;
      if (y === cy && d > today) continue;
      const v = map.get(toDateKey(d));
      if (v != null && Number.isFinite(v) && v !== 0) {
        const a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
      }
    }
  }
  if (maxAbs === 0) maxAbs = 1;

  const stats = pnlTradeStatsForYear(Array.isArray(trades) ? trades : [], y);
  const dayBw = pnlDayBestWorstForYear(map, y);
  const fmtStat = (x) =>
    x != null && Number.isFinite(x) ? formatUsd(x) : "—";

  const gainCls = [
    "bg-emerald-900/55",
    "bg-emerald-800/80",
    "bg-emerald-600/90",
    "bg-emerald-500",
    "bg-gain",
  ];
  const lossCls = [
    "bg-rose-900/55",
    "bg-rose-800/80",
    "bg-rose-600/90",
    "bg-rose-500",
    "bg-loss",
  ];

  const cellTier = (v) => {
    const t = Math.min(1, Math.abs(v) / maxAbs);
    return Math.min(4, Math.floor(t * 4.0001));
  };

  const weekdayOneLetter = ["M", "T", "W", "T", "F"];
  const labelCells = weekdayOneLetter
    .map(
      (ch) =>
        `<span class="aspect-square flex items-center justify-end text-[10px] text-slate-600 tabular-nums leading-none pr-0.5">${ch}</span>`,
    )
    .join("");

  const cellBox =
    "block aspect-square w-full rounded-sm border border-slate-800/90 ";

  const columns = [];
  const monthLabels = [];
  {
    let prevMonth = -1;
    for (let ci = 0; ci < weekMons.length; ci++) {
      const mon = weekMons[ci];
      const m = mon.getMonth();
      if (m !== prevMonth) {
        if (mon.getFullYear() === y) {
          monthLabels.push({ col: ci, label: mon.toLocaleString(undefined, { month: "short" }) });
        }
        prevMonth = m;
      }
    }
  }
  const totalCols = weekMons.length;
  const monthLabelCells = monthLabels.map((ml, i) => {
    const nextCol = i + 1 < monthLabels.length ? monthLabels[i + 1].col : totalCols;
    const span = nextCol - ml.col;
    return `<span class="text-[10px] text-slate-600 truncate" style="grid-column:${ml.col + 1}/span ${span}">${ml.label}</span>`;
  }).join("");
  const monthLabelRow = `<div class="grid min-w-0 w-full" style="grid-template-columns:repeat(${totalCols},minmax(0,1fr));gap:2px">${monthLabelCells}</div>`;
  for (const mon of weekMons) {
    const cells = [];
    for (let r = 0; r < 5; r++) {
      const d = addDays(mon, r);
      const dk = toDateKey(d);
      const inYear = d.getFullYear() === y;
      const isFuture = inYear && y === cy && d > today;
      const raw = map.get(dk);
      const has = inYear && !isFuture && raw != null && Number.isFinite(raw);
      const v = has ? raw : 0;
      let box = cellBox;
      if (!inYear) {
        box += "bg-slate-950/40 border-slate-800/40";
      } else if (isFuture) {
        box += "bg-slate-900/25 border-slate-800/40";
      } else if (!has) {
        box += "bg-slate-800/45";
      } else if (v === 0) {
        box += "bg-slate-700/70 border-slate-700";
      } else if (v > 0) {
        box += gainCls[cellTier(v)];
      } else {
        box += lossCls[cellTier(v)];
      }
      const tip = !inYear
        ? `${dk} (outside ${y})`
        : isFuture
          ? `${dk} (upcoming)`
          : has
            ? `${dk}: ${formatUsd(v)} net`
            : `${dk}: no trades`;
      cells.push(
        `<span class="${box}" role="img" aria-label="${escapeAttr(tip)}" title="${escapeAttr(tip)}"></span>`,
      );
    }
    columns.push(`<div class="flex flex-col gap-[2px] min-w-0">${cells.join("")}</div>`);
  }

  const legendSwatches = (classes, sign) =>
    classes
      .map(
        (c) =>
          `<span class="inline-block w-3.5 h-3.5 rounded-sm border border-slate-800/80 ${c}" title="${sign}"></span>`,
      )
      .join("");

  const yearOpts = opts
    .map(
      (yy) =>
        `<option value="${yy}"${yy === y ? " selected" : ""}>${yy}</option>`,
    )
    .join("");

    const statCardSidebar = (label, valueHtml) => `
    <div class="rounded-lg border border-slate-800/80 bg-surface-overlay/50 px-3 py-3 min-w-0 flex flex-col items-center justify-center text-center">
      <p class="text-[10px] font-medium text-slate-500 uppercase tracking-wide leading-tight">${label}</p>
      <p class="text-lg font-mono font-semibold tracking-tight mt-1 tabular-nums">${valueHtml}</p>
    </div>`;

  return `
    <section class="rounded-xl border border-slate-800 bg-surface-raised p-4 sm:p-5" aria-labelledby="pnl-heatmap-heading">
       <div class="flex items-center justify-between gap-3 mb-2">
        <h2 id="pnl-heatmap-heading" class="text-sm font-medium text-slate-400">P&amp;L heatmap</h2>
        <div class="flex items-center gap-2">
          <label for="pnl-heatmap-year" class="text-xs font-medium text-slate-500 whitespace-nowrap">Year</label>
          <select id="pnl-heatmap-year"
            class="select-flat min-h-[40px] rounded-lg border border-slate-700 bg-surface px-2.5 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent/80 min-w-[5.5rem]">
            ${yearOpts}
          </select>
        </div>
      </div>
      <p class="text-[10px] text-slate-600 mb-4 lg:mb-5">Days: net P&amp;L on the calendar day. Trades: round trips closed in ${y}. Grid: daily net (Mon–Fri).</p>

      <div class="flex flex-col lg:flex-row lg:items-stretch lg:gap-6">
        <div class="min-w-0 w-full lg:flex-[2] lg:basis-0">
          <p class="text-xs text-slate-600 mb-2">Older weeks on the left · darker = larger |daily P&amp;L| within ${y}</p>
          <div class="ml-5 mb-1">${monthLabelRow}</div>
          <div class="flex gap-1.5 sm:gap-2 min-w-0">
            <div class="flex flex-col gap-[2px] shrink-0 w-4 pt-px" aria-hidden="true">${labelCells}</div>
            <div class="min-w-0 flex-1 pb-1">
              <div class="grid w-full" style="grid-template-columns:repeat(${weekMons.length},minmax(0,1fr));gap:2px">${columns.join("")}</div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-[11px] text-slate-500">
            <span class="inline-flex items-center gap-1.5"><span class="text-slate-600">Loss</span> ${legendSwatches([...lossCls].reverse(), "loss")}</span>
            <span class="inline-flex items-center gap-1.5"><span class="w-3.5 h-3.5 rounded-sm border border-slate-800/80 bg-slate-800/45 shrink-0" title="No trades"></span> No trades</span>
            <span class="inline-flex items-center gap-1.5"><span class="text-slate-600">Gain</span> ${legendSwatches(gainCls, "gain")}</span>
          </div>
        </div>

        <div class="min-w-0 w-full lg:flex-1 lg:basis-0 mt-6 pt-6 border-t border-slate-800 lg:mt-0 lg:pt-0 lg:border-t-0 lg:border-l lg:pl-6">
          <div class="grid grid-cols-3 gap-2">
            ${statCardSidebar("Worst day", `<span class="text-loss">${fmtStat(dayBw.worstDay)}</span>`)}
            ${statCardSidebar("Best day", `<span class="text-gain">${fmtStat(dayBw.bestDay)}</span>`)}
            ${statCardSidebar("Worst trade", `<span class="text-loss">${fmtStat(stats.biggestLoser)}</span>`)}
            ${statCardSidebar("Best trade", `<span class="text-gain">${fmtStat(stats.biggestWinner)}</span>`)}
            ${statCardSidebar("Avg losing trade", `<span class="text-loss">${fmtStat(stats.avgLoser)}</span>`)}
            ${statCardSidebar("Avg winning trade", `<span class="text-gain">${fmtStat(stats.avgWinner)}</span>`)}
          </div>
        </div>
      </div>
    </section>`;
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
  const dayTrades = trades.filter(
    (t) => canonicalDateKey(t.dateKey) === dateKey,
  );
  const pnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = dayTrades.filter((t) => t.win).length;
  const losses = dayTrades.length - wins;
  return { pnl, wins, losses, count: dayTrades.length };
}

function weekStats(trades, dateKeys) {
  const weekTrades = trades.filter((t) =>
    dateKeys.includes(canonicalDateKey(t.dateKey)),
  );
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
  const hasTags = tradeMetaTagsNormalized(meta).length > 0;
  const { riskVal, totalInner } = tradeRiskDisplayParts(t, meta);
  const noteClass = hasNote
    ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/40"
    : "bg-slate-800 text-slate-600";
  const shotClass = hasShot
    ? "bg-sky-500/25 text-sky-200 ring-1 ring-sky-500/40"
    : "bg-slate-800 text-slate-600";
  const tagClass = hasTags
    ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/35"
    : "bg-slate-800 text-slate-600";
  const shareTitle = `Peak shares: ${t.maxShares} · Round-turn volume: ${t.shareTurnover}`;
  return `
    <tr class="hover:bg-surface-overlay/60 cursor-pointer transition-colors trade-row group" data-id="${escapeAttr(t.id)}">
      <td class="px-3 py-2 font-mono text-slate-400">${t.dateKey}</td>
      <td class="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">${formatTradeClock(t.openTs)}</td>
      <td class="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">${formatTradeClock(t.closeTs)}</td>
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
        <button type="button" class="meta-preview-trigger inline-flex items-center justify-center gap-1 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-2 py-2 sm:px-1 sm:py-1 rounded-lg hover:bg-slate-800/80 transition-colors active:bg-slate-800" data-trade-id="${escapeAttr(t.id)}" aria-label="Preview notes, tags, and screenshot">
          <span class="inline-flex h-7 w-7 sm:h-6 sm:min-w-[1.5rem] items-center justify-center rounded text-[10px] font-semibold ${noteClass}">N</span>
          <span class="inline-flex h-7 w-7 sm:h-6 sm:min-w-[1.5rem] items-center justify-center rounded text-[10px] font-semibold ${tagClass}">T</span>
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
  const hasTags = tradeMetaTagsNormalized(meta).length > 0;
  const { riskVal, totalInner } = tradeRiskDisplayParts(t, meta);
  const noteClass = hasNote
    ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/40"
    : "bg-slate-800 text-slate-600";
  const shotClass = hasShot
    ? "bg-sky-500/25 text-sky-200 ring-1 ring-sky-500/40"
    : "bg-slate-800 text-slate-600";
  const tagClass = hasTags
    ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/35"
    : "bg-slate-800 text-slate-600";
  const pnlCls = t.pnl > 0 ? "text-gain" : "text-loss";
  return `
    <article class="trade-mobile-card trade-row rounded-xl border border-slate-800 bg-surface-overlay/50 p-3 cursor-pointer" data-id="${escapeAttr(t.id)}">
      <div class="flex justify-between gap-3 items-start">
        <div class="min-w-0">
          <p class="text-base font-semibold text-white truncate">${escapeHtml(t.symbol)}</p>
          <p class="text-xs text-slate-500 font-mono mt-0.5">${t.dateKey} · open ${formatTradeClock(t.openTs)} · close ${formatTradeClock(t.closeTs)}</p>
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
        <button type="button" class="meta-preview-trigger inline-flex items-center gap-2 min-h-[44px] px-3 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800/80 active:bg-slate-800 transition-colors" data-trade-id="${escapeAttr(t.id)}" aria-label="Notes, tags, and screenshot">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded text-[10px] font-semibold ${noteClass}">N</span>
          <span class="inline-flex h-8 w-8 items-center justify-center rounded text-[10px] font-semibold ${tagClass}">T</span>
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
    const prev = state.tradeMetaById.get(tradeId) || emptyTradeMeta(tradeId);
    merged = await apiUpsertMeta({
      id: tradeId,
      notes: prev.notes ?? null,
      riskPerShare,
      screenshotUrl: prev.screenshotUrl ?? null,
      tags: tradeMetaTagsNormalized(prev),
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

/** `id="upload-account-select"` on Import trades only (which account receives the upload). */
function tradingAccountUploadSelectBlock(labelText) {
  const uploadOpts =
    `<option value="">Select an account…</option>` +
    (state.tradingAccounts || [])
      .map(
        (a) =>
          `<option value="${escapeAttr(a.id)}"${normImportId(a.id) === normImportId(state.uploadAccountId) ? " selected" : ""}>${escapeHtml(a.label)}${a.broker ? ` · ${escapeHtml(brokerDisplayName(a.broker))}` : ""}</option>`,
      )
      .join("");
  return `
      <div>
        <label for="upload-account-select" class="block text-xs font-medium text-slate-500 mb-1">${labelText}</label>
        <select id="upload-account-select"
          class="select-flat w-full min-h-[44px] rounded-lg border border-slate-700 bg-surface px-3 py-2.5 text-sm text-slate-200 shadow-inner shadow-black/10 focus:outline-none focus:ring-2 focus:ring-accent/80">
          ${uploadOpts}
        </select>
      </div>`;
}

function accountPageHtml() {
  const displayOpts =
    `<option value="">All trading accounts</option>` +
    (state.tradingAccounts || [])
      .map(
        (a) =>
          `<option value="${escapeAttr(a.id)}"${normImportId(a.id) === normImportId(state.displayAccountId) ? " selected" : ""}>${escapeHtml(a.label)}${a.broker ? ` · ${escapeHtml(brokerDisplayName(a.broker))}` : ""}</option>`,
      )
      .join("");
  const accountRows =
    (state.tradingAccounts || []).length === 0
      ? `<p class="text-sm text-slate-500 py-2">No trading accounts yet. Add one below (e.g. &quot;Main taxable&quot;, &quot;IRA&quot; — same broker is fine).</p>`
      : (state.tradingAccounts || [])
          .map((a) => {
            const n = countImportsForTradingAccount(a.id);
            return `<div class="flex items-start justify-between gap-3 py-3 border-b border-slate-800/80 last:border-0">
        <div class="min-w-0">
          <p class="text-sm font-medium text-slate-200">${escapeHtml(a.label)}</p>
          <p class="text-xs text-slate-500 mt-0.5">${a.broker ? `${escapeHtml(brokerDisplayName(a.broker))} · ` : ""}${n} CSV upload${n === 1 ? "" : "s"}</p>
        </div>
        <button type="button" class="shrink-0 text-xs text-loss hover:underline px-2 py-1 rounded disabled:opacity-40 disabled:pointer-events-none" data-delete-trading-account="${escapeAttr(a.id)}"${n > 0 ? " disabled" : ""} title="${n > 0 ? "Delete or reassign imports first" : "Delete this account"}">Delete</button>
      </div>`;
          })
          .join("");

  return `
    <section class="max-w-lg space-y-6">
      <div class="rounded-xl border border-slate-800 bg-surface-raised p-5 space-y-4">
        <h2 class="text-sm font-medium text-slate-400">Account</h2>
        <p class="text-sm text-slate-300" id="account-email"></p>
      </div>

      <div class="rounded-xl border border-slate-800 bg-surface-raised p-5 space-y-4 max-w-xl">
        <h2 class="text-sm font-medium text-slate-400">Trading accounts</h2>
        <p class="text-xs text-slate-500 leading-relaxed">
          A <strong class="text-slate-400">trading account</strong> is your label for a bucket of data (same broker twice = two accounts). <strong class="text-slate-400">Broker</strong> is the platform (metadata). <strong class="text-slate-400">Strategy tags</strong> stay on Import — comma-separated labels per upload (ORB, swing, etc.).
        </p>
        <p class="text-[11px] text-slate-600 leading-relaxed">
          If saving accounts fails, run <code class="text-slate-400">supabase/trading_accounts.sql</code> in the Supabase SQL editor once.
        </p>
        <div>${accountRows}</div>
        <div class="pt-2 border-t border-slate-800 space-y-3">
          <p class="text-xs font-medium text-slate-500 uppercase tracking-wide">Add account</p>
          <input type="text" id="new-trading-account-label" placeholder="e.g. Main taxable, IRA 2024"
            class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Broker (platform)</label>
            ${brokerPlatformSelectHtml("new-trading-account-broker", "Schwab")}
          </div>
          <button type="button" id="add-trading-account-btn"
            class="w-full py-2 rounded-lg bg-accent/15 text-accent text-sm font-medium border border-accent/30 hover:bg-accent/25">
            Add trading account
          </button>
        </div>
        <div class="pt-4 border-t border-slate-800 space-y-4">
          <div>
            <label for="display-account-select" class="block text-xs font-medium text-slate-500 mb-1">Dashboard &amp; calendar show</label>
            <select id="display-account-select"
              class="select-flat w-full min-h-[44px] rounded-lg border border-slate-700 bg-surface px-3 py-2.5 text-sm text-slate-200 shadow-inner shadow-black/10 focus:outline-none focus:ring-2 focus:ring-accent/80">
              ${displayOpts}
            </select>
            <p class="text-[11px] text-slate-600 mt-1.5">Pick one account to focus charts, or all accounts. You can change this from the dashboard too.</p>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-slate-800 bg-surface-raised p-5 space-y-4">
        <h2 class="text-sm font-medium text-slate-400">Change password</h2>
        <input type="password" id="new-password" placeholder="New password"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
        <input type="password" id="confirm-password" placeholder="Confirm password"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
        <button type="button" id="change-password-btn"
          class="w-full py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">
          Update password
        </button>
        <p id="password-msg" class="hidden text-sm"></p>
      </div>

      <div class="rounded-xl border border-red-900/40 bg-surface-raised p-5 space-y-4">
        <h2 class="text-sm font-medium text-red-400">Danger zone</h2>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-slate-300">Delete all trades</p>
            <p class="text-xs text-slate-500">Removes trades, eta, balance, import history, and trading accounts. Cannot be undone.</p>

            </div>
          <button type="button" id="delete-trades-btn"
class="px-4 py-2 rounded-lg bg-loss/15 text-loss text-sm border border-loss/30 hover:bg-loss/25 transition-colors whitespace-nowrap">
            Delete all
          </button>
        </div>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm text-slate-300">Delete account</p>
            <p class="text-xs text-slate-500">Permanently deletes your account and all data.</p>
          </div>
          <button type="button" id="delete-account-btn"
            class="px-4 py-2 rounded-lg bg-loss/15 text-loss text-sm border border-loss/30 hover:bg-loss/25 transition-colors">
            Delete account
          </button>
        </div>
      </div>
    </section>
  `;
}

function tradeImportPageHtml() {
  const hasAccounts = (state.tradingAccounts || []).length > 0;
  return `
    <section class="rounded-xl border border-slate-800 bg-surface-raised p-5 max-w-xl space-y-4">
      <h2 class="text-sm font-medium text-slate-400">Import trades</h2>
      <p class="text-sm text-slate-500">
        Pick one or more Schwab cash journal CSVs.
      </p>

      ${
        hasAccounts
          ? `${tradingAccountUploadSelectBlock("Trading account")}
      <div>
        <label for="import-tags" class="block text-xs font-medium text-slate-500 mb-1">Filter tags (comma separated, optional)</label>
        <input type="text" id="import-tags" placeholder="e.g. ORB, momentum"
          class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent" />
      </div>`
          : `<p class="text-sm text-amber-200/90">Add a trading account on the <strong class="text-slate-300">Account</strong> page first, then return here.</p>`
      }

      <input type="file" accept=".csv,text/csv" multiple class="hidden" id="file-input" />
      <button type="button" id="import-csv-trigger"
        class="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-lg bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25 transition-colors border border-accent/30${hasAccounts ? "" : " opacity-40 pointer-events-none"}"
        ${hasAccounts ? "" : " disabled"}>
        Choose CSV file(s)
      </button>
    </section>
  `;
}

function render() {
  closeMobileNav();
  const root = $("#app");
  const dayFilter = state.selectedDay;
  const { page } = state;
  const onDashboard = page === Page.Dashboard;
  const onAccount = page === Page.Account;
  const onCalendar = page === Page.Calendar;
  const onTradeImport = page === Page.TradeImport;
  /** Equity curve, statistics (KPIs + sparkline), weekday chart — not on Account / Import. */
  const showChartsRow = onDashboard || onCalendar;

  const importsScope = importsInDisplayScope(
    state.imports,
    state.displayAccountId,
  );
  const baseTradesForTags = filteredTradesByAccount(
    state.trades,
    state.imports,
    state.displayAccountId,
  );
  const tagOptions = mergedDashboardTagOptions(
    importsScope,
    baseTradesForTags,
  );
  const tagLcToCanon = new Map();
  for (const t of tagOptions) {
    const label = String(t).trim();
    if (!label) continue;
    tagLcToCanon.set(label.toLowerCase(), label);
    const k = tagKeyForMatch(label);
    if (k && !tagLcToCanon.has(k)) tagLcToCanon.set(k, label);
  }
  state.dashboardTagFilters = [
    ...new Set(
      (state.dashboardTagFilters || [])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .map(
          (t) =>
            tagLcToCanon.get(t.toLowerCase()) ??
            tagLcToCanon.get(tagKeyForMatch(t)) ??
            t,
        ),
    ),
  ];
  persistDashboardTagFilters();

  const { baseTrades, tradesView } = dashboardScope();

  const wantTags = state.dashboardTagFilters.length > 0;
  const tradesLinked = baseTrades.some((t) => normImportId(t.importId) !== "");
  const tagWarnNoLinks = Boolean(
    wantTags && baseTrades.length > 0 && !tradesLinked,
  );
  const tagWarnNoMatches = Boolean(
    wantTags && tradesView.length === 0 && baseTrades.length > 0,
  );
  const m = computeMetrics(tradesView);
  const trades = tradesView;

  const dispAcc = tradingAccountById(state.displayAccountId);
  const filesLabelExtra =
    (state.dashboardTagFilters.length > 0
      ? ` · tags: ${state.dashboardTagFilters.map(escapeHtml).join(", ")}`
      : "") +
    (dispAcc
      ? ` · trading account: ${dispAcc.label}${dispAcc.broker ? ` (${brokerDisplayName(dispAcc.broker)})` : ""}`
      : "");

  const displayAccountOpts =
    `<option value="">All trading accounts</option>` +
    (state.tradingAccounts || [])
      .map(
        (a) =>
          `<option value="${escapeAttr(a.id)}"${normImportId(a.id) === normImportId(state.displayAccountId) ? " selected" : ""}>${escapeHtml(a.label)}${a.broker ? ` · ${escapeHtml(brokerDisplayName(a.broker))}` : ""}</option>`,
      )
      .join("");

  const showTagFilterUi =
    showChartsRow &&
    (state.trades.length > 0 || state.imports.length > 0);
  const tagFilterWarnHtml = tagWarnNoMatches
    ? `<div class="mb-3 rounded-lg border border-slate-600 bg-slate-800/90 px-3 py-2.5 text-xs text-slate-300 leading-relaxed">
        No trades match <strong>all</strong> of these tags (each tag must appear on the trade’s CSV import <strong>or</strong> on the trade itself): <strong>${state.dashboardTagFilters.map(escapeHtml).join(", ")}</strong>. Adjust filters or clear chips.
      </div>`
    : tagWarnNoLinks
      ? `<div class="mb-3 rounded-lg border border-amber-500/45 bg-amber-950/55 px-3 py-2.5 text-xs text-amber-100 leading-relaxed">
        Your saved <strong>round trips</strong> are missing <span class="font-mono text-amber-200/90">import_id</span>, so <strong>CSV import tags</strong> cannot match them until you <strong>re-upload</strong> from <strong>Import trades</strong>. You can still filter using <strong>per-trade tags</strong> (open a trade → Tags field → Save).
      </div>`
      : "";

  const tagFilterBarHtml = showTagFilterUi
    ? `<section class="rounded-xl border border-slate-700/80 bg-gradient-to-b from-surface-raised to-surface-overlay/40 px-4 py-4 sm:px-5 sm:py-4 mb-6 shadow-lg shadow-black/30 ring-1 ring-slate-800/80" aria-labelledby="dashboard-scope-heading">
        <div class="mb-3">
          <h3 id="dashboard-scope-heading" class="text-sm font-semibold tracking-tight text-white">Dashboard &amp; calendar scope</h3>
        </div>
        ${tagFilterWarnHtml}
        <div class="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-4">
          <div class="flex shrink-0 flex-col gap-1.5 md:w-[min(100%,15rem)] lg:w-[17rem]">
            <label for="dashboard-display-account" class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Trading account</label>
            <select id="dashboard-display-account" class="select-flat h-11 w-full rounded-lg border border-slate-600/90 bg-surface px-3 py-0 text-sm leading-normal text-slate-100 shadow-inner shadow-black/20 focus:outline-none focus:ring-2 focus:ring-accent/80 focus:border-accent/50">
              ${displayAccountOpts}
            </select>
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <label for="dashboard-tag-input" class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Filter tags</label>
            <div class="flex min-h-11 min-w-0 flex-wrap items-center gap-2 rounded-lg border border-slate-600/90 bg-slate-950/40 px-2 shadow-inner shadow-black/20">
              <div class="relative flex h-11 min-w-[10rem] flex-1 items-stretch sm:max-w-[13rem] sm:flex-none sm:w-[13rem]">
                <input type="text" id="dashboard-tag-input" autocomplete="off" spellcheck="false" placeholder="Search tags…"
                  class="h-full min-h-0 w-full border-0 bg-transparent px-2.5 text-sm leading-normal text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-0" />
                <div id="dashboard-tag-suggestions" class="absolute left-0 right-0 top-full z-[80] mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-600/90 bg-slate-950 py-1 shadow-xl shadow-black/40 hidden" role="listbox" aria-label="Tag suggestions"></div>
              </div>
              <div class="hidden h-7 w-px shrink-0 self-center bg-slate-600/50 sm:block" aria-hidden="true"></div>
              <div id="dashboard-tag-chips" class="flex min-h-0 min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 py-0.5 pl-1 sm:pl-2"></div>
            </div>
          </div>
        </div>
      </section>`
    : "";

  const heatmapYears = onDashboard ? pnlHeatmapYearOptions(trades) : [];
  if (onDashboard && heatmapYears.length && !heatmapYears.includes(state.pnlHeatmapYear)) {
    state.pnlHeatmapYear = heatmapYears[0];
  }

  const cal = state.calendarMonth;
  let calendarTableTrades = tradesClosedInMonth(
    trades,
    cal.getFullYear(),
    cal.getMonth(),
  );
  if (dayFilter != null) {
    calendarTableTrades = calendarTableTrades.filter(
      (t) => canonicalDateKey(t.dateKey) === dayFilter,
    );
  }
  calendarTableTrades = sortTradesForTable(
    calendarTableTrades,
    state.tradeTableSort.column,
    state.tradeTableSort.direction,
  );
  const sortShort = `${state.tradeTableSort.column} ${state.tradeTableSort.direction}`;
  const calendarTableCaption = dayFilter
    ? `Day: ${dayFilter} · ${calendarTableTrades.length} shown · sort: ${sortShort}`
    : `${cal.toLocaleString(undefined, { month: "long", year: "numeric" })} · ${calendarTableTrades.length} shown · sort: ${sortShort}`;

  const dashboardStatsHtml = `
    <section class="grid sm:grid-cols-2 lg:grid-cols-5 gap-4" id="stat-cards">
      ${statCard("Counted trades", m ? String(m.tradeCount) : "—")}
      ${statCard("Win rate", m ? formatPct(m.winRate) : "—", "Breakeven counts as loss")}
      ${statCard("Profit factor", m ? formatPF(m.profitFactor) : "—")}
      ${statCard("Avg return per dollar", m ? formatPct(m.avgReturnPerDollar) : "—", "Mean of each trade’s P&amp;L ÷ (½ × sum of |fill amounts|)")}
      ${statCard("Total P&amp;L", m ? formatUsd(m.totalPnl) : "—")}
    </section>`;

  const calendarHtml = `
    <section class="space-y-6">
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
            <span class="text-xs text-slate-500">${calendarTableCaption}</span>
          </div>
          <div class="md:hidden flex flex-wrap items-center gap-2 border-b border-slate-800/90 px-3 py-2">
            <span class="text-xs text-slate-500 shrink-0">Sort</span>
            <select id="trade-sort-column" class="select-flat min-h-[40px] flex-1 min-w-[8rem] rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent/80">
              <option value="dateKey"${state.tradeTableSort.column === "dateKey" ? " selected" : ""}>Date</option>
              <option value="openTs"${state.tradeTableSort.column === "openTs" ? " selected" : ""}>Opened</option>
              <option value="closeTs"${state.tradeTableSort.column === "closeTs" ? " selected" : ""}>Closed</option>
              <option value="symbol"${state.tradeTableSort.column === "symbol" ? " selected" : ""}>Symbol</option>
              <option value="openSide"${state.tradeTableSort.column === "openSide" ? " selected" : ""}>Side</option>
              <option value="maxShares"${state.tradeTableSort.column === "maxShares" ? " selected" : ""}>Shares</option>
              <option value="riskPerShare"${state.tradeTableSort.column === "riskPerShare" ? " selected" : ""}>Risk/sh</option>
              <option value="totalRisk"${state.tradeTableSort.column === "totalRisk" ? " selected" : ""}>Total risk</option>
              <option value="rr"${state.tradeTableSort.column === "rr" ? " selected" : ""}>R:R</option>
              <option value="pnl"${state.tradeTableSort.column === "pnl" ? " selected" : ""}>P&amp;L</option>
              <option value="result"${state.tradeTableSort.column === "result" ? " selected" : ""}>Result</option>
              <option value="notesMeta"${state.tradeTableSort.column === "notesMeta" ? " selected" : ""}>Notes</option>
            </select>
            <select id="trade-sort-direction" class="select-flat min-h-[40px] rounded-md border border-slate-700 bg-surface px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent/80">
              <option value="asc"${state.tradeTableSort.direction === "asc" ? " selected" : ""}>Asc</option>
              <option value="desc"${state.tradeTableSort.direction === "desc" ? " selected" : ""}>Desc</option>
            </select>
          </div>
          <div class="hidden md:block overflow-x-auto touch-pan-x">
            <table class="w-full text-sm min-w-[1180px]">
              <thead class="text-left text-slate-500 border-b border-slate-800">
                <tr>
                  ${tradeTableSortableTh("Date", "dateKey")}
                  ${tradeTableSortableTh("Opened", "openTs", "", "First fill (local wall time)")}
                  ${tradeTableSortableTh("Closed", "closeTs", "", "Last fill (local wall time)")}
                  ${tradeTableSortableTh("Symbol", "symbol")}
                  ${tradeTableSortableTh("Side", "openSide")}
                  ${tradeTableSortableTh("Shares", "maxShares", "text-right cursor-help", "Peak shares held during the trade. Cell tooltip: round-turn share volume.")}
                  ${tradeTableSortableTh("Risk/sh $", "riskPerShare", "text-right cursor-help", "Dollar risk per share (e.g. distance to stop). Total risk = this × peak shares.")}
                  ${tradeTableSortableTh("Total risk", "totalRisk", "text-right cursor-help", "Risk/sh × peak shares, when risk/sh is set.")}
                  ${tradeTableSortableTh("R:R", "rr", "text-right cursor-help", "P&amp;L divided by total risk (1R = amount risked). Shown only when total risk is set.")}
                  ${tradeTableSortableTh("P&amp;L", "pnl", "text-right")}
                  ${tradeTableSortableTh("Result", "result")}
                  ${tradeTableSortableTh("Notes", "notesMeta", "text-center cursor-help", "Sorts by note text (empty notes sort first in ascending order)")}
                  <th class="px-2 py-2 font-medium text-right w-10 text-slate-500"><span class="sr-only">Options</span></th>
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
        </section>
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
      ${navBtn(Page.Account, "Account")}
      ${navBtn(Page.Dashboard, "Dashboard")}
      ${navBtn(Page.Calendar, "Calendar")}
      ${navBtn(Page.TradeImport, "Import trades")}
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
          </div>
        </div>
        <button type="button" id="logout-btn" class="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-lg bg-surface-overlay text-slate-400 text-sm hover:bg-slate-800 transition-colors border border-slate-700 shrink-0">
          Logout
        </button>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-8 sm:space-y-10 w-full min-w-0">
      <p class="text-sm text-slate-500" id="file-status">${escapeHtml(state.filesLabel)}${escapeHtml(filesLabelExtra)}</p>
      ${tagFilterBarHtml}

      ${onDashboard ? dashboardStatsHtml : ""}
      ${onAccount ? accountPageHtml() : ""}
      ${onTradeImport ? tradeImportPageHtml() : ""}

      ${
        showChartsRow
          ? `<section class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div class="rounded-xl border border-slate-800 bg-surface-raised p-4 min-w-0">
          <h2 class="text-sm font-medium text-slate-400 ${onCalendar ? "mb-1" : "mb-3"}">Equity curve</h2>
          ${onCalendar ? `<p class="text-xs text-slate-600 mb-2">Account balance for the selected month (same scope as Statistics).</p>` : ""}
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
      </section>`
          : ""
      }

      ${onDashboard ? renderPnlHeatmapSectionHtml(m?.byDayPnl, trades, state.pnlHeatmapYear, heatmapYears) : ""}

      ${onCalendar ? calendarHtml : ""}
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
          ${navBtn(Page.Account, "Account")}
          ${navBtn(Page.Dashboard, "Dashboard")}
          ${navBtn(Page.Calendar, "Calendar")}
          ${navBtn(Page.TradeImport, "Import trades")}
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
            <label class="block text-xs font-medium text-slate-500 mb-1">Import tags</label>
            <div id="modal-import-tags-chips" class="flex flex-wrap gap-1.5 mb-2 min-h-[2rem] items-center"></div>
            <div id="modal-import-tags-add-row" class="flex flex-col sm:flex-row gap-2">
              <input type="text" id="modal-import-tag-add" autocomplete="off" spellcheck="false" placeholder="Add a tag…"
                class="min-w-0 flex-1 rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" id="modal-import-tag-add-btn" class="min-h-[44px] shrink-0 rounded-lg border border-slate-600 px-4 text-sm text-slate-200 hover:bg-slate-800/80 transition-colors">Add</button>
            </div>
            <p class="text-[11px] text-slate-600 mt-1">These apply to <strong class="text-slate-500">every trade</strong> from this CSV upload. Edit here and press <strong class="text-slate-400">Save</strong> (same as per-trade tags below).</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Tags on this trade</label>
            <div id="modal-trade-tags-chips" class="flex flex-wrap gap-1.5 mb-2 min-h-[2rem] items-center"></div>
            <div class="flex flex-col sm:flex-row gap-2">
              <input type="text" id="modal-trade-tag-add" autocomplete="off" spellcheck="false" placeholder="Add a tag…"
                class="min-w-0 flex-1 rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" id="modal-trade-tag-add-btn" class="min-h-[44px] shrink-0 rounded-lg border border-slate-600 px-4 text-sm text-slate-200 hover:bg-slate-800/80 transition-colors">Add</button>
            </div>
            <p class="text-[11px] text-slate-600 mt-1">Remove tags with <strong class="text-slate-500">×</strong>. Dashboard filters match import tags <strong class="text-slate-500">or</strong> these per-trade tags (every selected chip must match).</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Screenshot</label>
            <input type="file" accept="image/*" id="modal-shot" class="text-sm text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-surface-overlay file:text-slate-200" />
            <p class="text-[11px] text-slate-600 mt-1">Choose an image, then press <span class="text-slate-400">Save</span> at the bottom.</p>
            <div id="modal-preview" class="mt-3 rounded-lg overflow-hidden border border-slate-800 hidden">
              <img alt="" title="Click to enlarge" class="w-full max-h-64 object-contain bg-black/40 cursor-zoom-in" id="modal-img" />
            </div>
            <button type="button" id="modal-clear-shot" class="mt-2 text-xs text-slate-500 hover:text-loss hidden">Remove image</button>
          </div>
          <button type="button" id="modal-save" class="w-full min-h-[48px] py-3 sm:py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">Save</button>
        </div>
      </div>
    </div>

    <div id="screenshot-lightbox" class="fixed inset-0 z-[85] hidden items-center justify-center bg-black/92 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Enlarged screenshot" aria-hidden="true">
      <button type="button" id="screenshot-lightbox-close" class="absolute top-3 right-3 sm:top-4 sm:right-4 z-10 min-h-[44px] min-w-[44px] rounded-lg text-3xl leading-none text-slate-400 hover:text-white hover:bg-white/10 transition-colors" aria-label="Close enlarged view">&times;</button>
      <img id="screenshot-lightbox-img" alt="" class="max-h-[min(92vh,92dvh)] max-w-full w-auto h-auto object-contain shadow-2xl select-none" draggable="false" />
    </div>

    <div id="calendar-day-note-modal" class="fixed inset-0 z-[60] hidden items-center justify-center bg-black/70 backdrop-blur-sm p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]" role="dialog" aria-modal="true" aria-labelledby="calendar-day-note-modal-heading" aria-hidden="true">
      <div class="bg-surface-raised border border-slate-800 rounded-xl max-w-md w-full max-h-[min(88vh,100dvh-2rem)] overflow-y-auto shadow-2xl">
        <div class="p-4 border-b border-slate-800 flex justify-between items-start gap-3">
          <div>
            <h3 id="calendar-day-note-modal-heading" class="text-base font-semibold text-white">Day comment</h3>
            <p class="text-xs text-slate-500 mt-1" id="calendar-day-note-modal-date"></p>
          </div>
          <button type="button" id="calendar-day-note-cancel" class="text-slate-500 hover:text-white text-2xl leading-none min-h-[44px] min-w-[44px] shrink-0 rounded-lg hover:bg-slate-800/80" aria-label="Close">&times;</button>
        </div>
        <div class="p-4 space-y-4">
          <div>
            <label for="calendar-day-note-text" class="block text-xs font-medium text-slate-500 mb-1">Comment</label>
            <textarea id="calendar-day-note-text" rows="5" class="w-full rounded-lg bg-surface border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-accent" placeholder="Journal, context, what stood out…"></textarea>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" id="calendar-day-note-save" class="min-h-[44px] px-4 rounded-lg bg-accent text-white text-sm font-medium hover:bg-blue-500 transition-colors">Save</button>
            <button type="button" id="calendar-day-note-clear" class="min-h-[44px] px-4 rounded-lg border border-slate-600 text-slate-300 text-sm hover:bg-slate-800/80 transition-colors">Clear note</button>
          </div>
        </div>
      </div>
    </div>
  `;

  bind();
  paintCharts();
  paintCalendar();
  queueMicrotask(() => {
    renderDashboardTagChipsDom();
    hideDashboardTagSuggestions();
  });
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

/** Local wall-clock time from a Unix ms timestamp (open or close). */
function formatTradeClock(ts) {
  if (ts == null || !Number.isFinite(Number(ts))) return "—";
  const d = new Date(Number(ts));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** @deprecated use formatTradeClock — kept for readability at call sites */
function formatCloseTime(ts) {
  return formatTradeClock(ts);
}

function metaForTradeSort(tradeId) {
  return state.tradeMetaById.get(tradeId) || emptyTradeMeta(tradeId);
}

function totalRiskSortValue(t) {
  const meta = metaForTradeSort(t.id);
  const rps = meta.riskPerShare;
  const rpsNum =
    rps != null && rps !== "" && Number.isFinite(Number(rps))
      ? Number(rps)
      : null;
  if (rpsNum == null || !(t.maxShares > 0)) return null;
  return rpsNum * t.maxShares;
}

function compareTradesForTable(a, b, col, dir) {
  const asc = dir === "asc" ? 1 : -1;
  const ncmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  switch (col) {
    case "dateKey":
      return (
        asc *
        ncmp(
          canonicalDateKey(a.dateKey),
          canonicalDateKey(b.dateKey),
        )
      );
    case "openTs":
      return asc * ncmp(a.openTs ?? 0, b.openTs ?? 0);
    case "closeTs":
      return asc * ncmp(a.closeTs ?? 0, b.closeTs ?? 0);
    case "symbol":
      return asc * String(a.symbol).localeCompare(String(b.symbol));
    case "openSide":
      return asc * String(a.openSide).localeCompare(String(b.openSide));
    case "maxShares":
      return asc * ncmp(a.maxShares ?? 0, b.maxShares ?? 0);
    case "riskPerShare": {
      const ra = metaForTradeSort(a.id).riskPerShare;
      const rb = metaForTradeSort(b.id).riskPerShare;
      const na = Number.isFinite(Number(ra)) ? Number(ra) : null;
      const nb = Number.isFinite(Number(rb)) ? Number(rb) : null;
      if (na == null && nb == null) return 0;
      if (na == null) return 1;
      if (nb == null) return -1;
      return asc * ncmp(na, nb);
    }
    case "totalRisk": {
      const va = totalRiskSortValue(a);
      const vb = totalRiskSortValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return asc * ncmp(va, vb);
    }
    case "rr": {
      const rra = tradeRiskRewardMultiple(a, metaForTradeSort(a.id));
      const rrb = tradeRiskRewardMultiple(b, metaForTradeSort(b.id));
      if (rra == null && rrb == null) return 0;
      if (rra == null) return 1;
      if (rrb == null) return -1;
      return asc * ncmp(rra, rrb);
    }
    case "pnl":
      return asc * ncmp(a.pnl ?? 0, b.pnl ?? 0);
    case "result": {
      const va = a.win ? 1 : 0;
      const vb = b.win ? 1 : 0;
      return dir === "desc" ? vb - va : va - vb;
    }
    case "notesMeta": {
      const sa = (metaForTradeSort(a.id).notes || "").trim().toLowerCase();
      const sb = (metaForTradeSort(b.id).notes || "").trim().toLowerCase();
      return asc * sa.localeCompare(sb);
    }
    default:
      return 0;
  }
}

function sortTradesForTable(list, column, direction) {
  const arr = [...(list || [])];
  arr.sort((a, b) => compareTradesForTable(a, b, column, direction));
  return arr;
}

function tradeTableSortableTh(label, colId, extraClass = "", title = "") {
  const { column, direction } = state.tradeTableSort;
  const active = column === colId;
  const arrow = !active ? "" : direction === "asc" ? " ▲" : " ▼";
  const cls = `px-3 py-2 font-medium ${extraClass} ${active ? "text-slate-300" : "text-slate-500"} cursor-pointer hover:text-slate-300 select-none`;
  const tit = title ? ` title="${escapeAttr(title)}"` : "";
  return `<th scope="col"${tit} class="${cls}" data-trade-sort="${escapeAttr(colId)}" tabindex="0">${escapeHtml(label)}${arrow}</th>`;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function hideDashboardTagSuggestions() {
  clearTimeout(dashboardTagBlurHideTimer);
  dashboardTagBlurHideTimer = null;
  const box = $("#dashboard-tag-suggestions");
  if (box) {
    box.classList.add("hidden");
    box.innerHTML = "";
  }
  dashboardTagSuggestHighlight = -1;
}

function scheduleHideDashboardTagSuggestions() {
  clearTimeout(dashboardTagBlurHideTimer);
  dashboardTagBlurHideTimer = window.setTimeout(() => {
    dashboardTagBlurHideTimer = null;
    hideDashboardTagSuggestions();
  }, 200);
}

function cancelHideDashboardTagSuggestions() {
  clearTimeout(dashboardTagBlurHideTimer);
  dashboardTagBlurHideTimer = null;
}

function dashboardTagPickerPool() {
  const chosen = new Set(
    (state.dashboardTagFilters || []).map((t) => tagKeyForMatch(t)).filter(Boolean),
  );
  const all = mergedDashboardTagOptions(
    importsInDisplayScope(state.imports, state.displayAccountId),
    filteredTradesByAccount(
      state.trades,
      state.imports,
      state.displayAccountId,
    ),
  );
  return all.filter((t) => !chosen.has(tagKeyForMatch(t)));
}

function computeDashboardTagSuggestionRows() {
  const input = $("#dashboard-tag-input");
  const q = input ? String(input.value || "").trim() : "";
  const pool = dashboardTagPickerPool();
  if (!pool.length) return [];
  if (!q) return pool.slice(0, 25);
  const fuse = new Fuse(
    pool.map((label) => ({ label: String(label) })),
    { keys: ["label"], threshold: 0.45, ignoreLocation: true },
  );
  return fuse.search(q).slice(0, 25).map((r) => r.item.label);
}

function updateDashboardTagSuggestions(options = {}) {
  const resetHighlight = options.resetHighlight !== false;
  if (resetHighlight) dashboardTagSuggestHighlight = -1;
  const input = $("#dashboard-tag-input");
  const box = $("#dashboard-tag-suggestions");
  if (!input || !box) return;

  const rows = computeDashboardTagSuggestionRows();
  const q = String(input.value || "").trim();
  if (!rows.length) {
    if (q && dashboardTagPickerPool().length) {
      box.innerHTML = `<div class="px-3 py-2.5 text-xs text-slate-500 italic">No matching tags</div>`;
      box.classList.remove("hidden");
    } else {
      box.classList.add("hidden");
      box.innerHTML = "";
    }
    return;
  }

  if (dashboardTagSuggestHighlight >= rows.length) {
    dashboardTagSuggestHighlight = rows.length - 1;
  }
  if (dashboardTagSuggestHighlight < -1) {
    dashboardTagSuggestHighlight = -1;
  }

  box.innerHTML = rows
    .map(
      (label, i) =>
        `<button type="button" role="option" data-dashboard-tag-suggest="${escapeAttr(label)}" class="dashboard-tag-suggest-item w-full text-left px-3 py-2 text-sm transition-colors hover:bg-slate-800/90 ${i === dashboardTagSuggestHighlight ? "bg-accent/15 text-white" : "text-slate-200"}">${escapeHtml(label)}</button>`,
    )
    .join("");
  box.classList.remove("hidden");
}

function renderDashboardTagChipsDom() {
  const wrap = $("#dashboard-tag-chips");
  if (!wrap) return;
  const tags = state.dashboardTagFilters || [];
  wrap.innerHTML = tags
    .map(
      (t) =>
        `<span class="inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent/10 pl-2.5 pr-1 py-0.5 text-xs font-medium text-slate-100 max-w-full ring-1 ring-slate-700/40">
          <span class="truncate max-w-[14rem]">${escapeHtml(t)}</span>
          <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white transition-colors" data-dashboard-tag-remove="${escapeAttr(t)}" aria-label="Remove tag">×</button>
        </span>`,
    )
    .join("");
}

function addDashboardTagFilter(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;
  const opts = mergedDashboardTagOptions(
    importsInDisplayScope(state.imports, state.displayAccountId),
    filteredTradesByAccount(
      state.trades,
      state.imports,
      state.displayAccountId,
    ),
  );
  const byLower = new Map(
    opts.map((x) => [String(x).trim().toLowerCase(), String(x).trim()]),
  );
  const byKey = new Map();
  for (const x of opts) {
    const label = String(x).trim();
    if (!label) continue;
    const k = tagKeyForMatch(label);
    if (k && !byKey.has(k)) byKey.set(k, label);
  }
  const lc = t.toLowerCase();
  const key = tagKeyForMatch(t);
  const canon = byLower.get(lc) ?? byKey.get(key) ?? t;
  const cur = new Set(
    (state.dashboardTagFilters || []).map((x) => tagKeyForMatch(x)).filter(Boolean),
  );
  if (cur.has(tagKeyForMatch(canon))) return false;
  state.dashboardTagFilters = [...(state.dashboardTagFilters || []), canon];
  persistDashboardTagFilters();
  return true;
}

function onDashboardTagInputKeydown(e) {
  if (!(e.target instanceof HTMLInputElement)) return;
  if (e.target.id !== "dashboard-tag-input") return;

  if (e.key === "Escape") {
    e.preventDefault();
    hideDashboardTagSuggestions();
    return;
  }

  if (e.key === ",") {
    e.preventDefault();
    const parts = e.target.value.split(",");
    const head = parts[0].trim();
    const tail = parts.slice(1).join(",").trim();
    if (addDashboardTagFilter(head)) {
      e.target.value = tail;
      hideDashboardTagSuggestions();
      render();
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    const rows = computeDashboardTagSuggestionRows();
    if (!rows.length) return;
    dashboardTagSuggestHighlight = Math.min(
      rows.length - 1,
      dashboardTagSuggestHighlight + 1,
    );
    updateDashboardTagSuggestions({ resetHighlight: false });
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    const rows = computeDashboardTagSuggestionRows();
    if (!rows.length) return;
    dashboardTagSuggestHighlight = Math.max(-1, dashboardTagSuggestHighlight - 1);
    updateDashboardTagSuggestions({ resetHighlight: false });
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    const rows = computeDashboardTagSuggestionRows();
    let pick =
      dashboardTagSuggestHighlight >= 0 &&
      dashboardTagSuggestHighlight < rows.length
        ? rows[dashboardTagSuggestHighlight]
        : "";
    const typed = String(e.target.value || "").trim();
    if (!pick && typed) {
      if (addDashboardTagFilter(typed)) {
        e.target.value = "";
        hideDashboardTagSuggestions();
        render();
        return;
      }
      pick = rows[0] || "";
    } else if (!pick) {
      pick = typed;
    }
    if (pick && addDashboardTagFilter(pick)) {
      e.target.value = "";
      hideDashboardTagSuggestions();
      render();
    }
  }
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
        tags: tradeMetaTagsNormalized({ tags: r.tags }),
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
  const ttags = tradeMetaTagsNormalized(meta);
  let inner = `<div class="popover-inner rounded-lg border border-slate-600 bg-slate-950 shadow-2xl p-3 w-[min(280px,calc(100vw-16px))] max-h-[min(28rem,calc(100svh-24px))] overflow-y-auto text-xs text-slate-200 space-y-2 pointer-events-auto">`;
  if (note) {
    inner += `<div class="text-slate-400 text-[10px] font-medium uppercase tracking-wide">Note</div><div class="whitespace-pre-wrap max-h-36 overflow-y-auto text-slate-200 leading-snug">${escapeHtml(note)}</div>`;
  }
  if (ttags.length) {
    inner += `<div class="text-slate-400 text-[10px] font-medium uppercase tracking-wide">Tags</div><div class="flex flex-wrap gap-1">${ttags.map((tg) => `<span class="rounded-md border border-slate-600 bg-slate-900/80 px-1.5 py-0.5 text-[11px] text-slate-200">${escapeHtml(tg)}</span>`).join("")}</div>`;
  }
  if (shotUrl) {
    inner += `<div class="text-slate-400 text-[10px] font-medium uppercase tracking-wide">Screenshot</div><img src="${shotUrl}" alt="" class="max-w-full max-h-44 object-contain rounded border border-slate-700 bg-black/30" />`;
  }
  if (!note && !shotUrl && !ttags.length) {
    inner += `<p class="text-slate-500 text-center py-2">No note, tags, or screenshot yet.</p>`;
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
  $("#pnl-heatmap-year")?.addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) {
      state.pnlHeatmapYear = v;
      render();
    }
  });

  $("#import-csv-trigger")?.addEventListener("click", () => {
    $("#file-input")?.click();
  });

  $("#file-input")?.addEventListener("change", async (e) => {
    const input = e.target;
    const files = input.files;
    if (!files?.length) return;

    const uploadId = (state.uploadAccountId || "").trim();
    if (!uploadId) {
      alert("Pick a trading account first (dropdown on this page).");
      input.value = "";
      return;
    }
    const accRow = tradingAccountById(uploadId);  
    const broker = (accRow?.broker || "Other").trim() || "Other";
    const tagsRaw = $("#import-tags")?.value || "";
    const tags = tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const filename = [...files].map(f => f.name).join(", ");

    let importRecord;
    try {
        importRecord = await apiCreateImport(broker, tags, filename, uploadId);
    } catch (err) {
        alert(`Failed to create import: ${err.message}`);
        input.value = "";
        return;
    }
    if (!importRecord?.id) {
        alert("Import did not return an id. Check the server and database imports table.");
        input.value = "";
        return;
    }

    const parts = await parseFiles(files);
    const { fills, balancePoints } = mergeExtracts(parts);
    const userId = localStorage.getItem("user_id");
    const trades = buildRoundTripTrades(fills, userId);

    try {
        await apiUpsertTrades(trades, importRecord.id);
    } catch (err) {
        console.error("Failed to save trades:", err);
        state.filesLabel = `Could not save trades: ${err.message}`;
        alert(`Trades were not saved to your account.\n\n${err.message}\n\nTry again, or check that you are logged in and the network is OK.`);
        input.value = "";
        return;
    }
    try {
        await apiUpsertBalance(balancePoints, importRecord.id);
    } catch (err) {
        console.error("Failed to save balance:", err);
        alert(`Trades were saved, but account balance snapshots failed to save.\n\n${err.message}`);
    }
    try {
      const [allRows, allBal] = await Promise.all([
        apiGetTrades(),
        apiGetBalance(),
      ]);
      state.trades = (allRows || []).map((r) => ({
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
        importId: r.import_id ?? null,
      }));
      state.balanceSnapshots = (allBal || []).map((r) => ({
        ts: r.ts,
        dateKey: r.date_key,
        balance: r.balance,
        importId: r.import_id ?? null,
      }));
    } catch (e) {
      console.error("Failed to reload trades/balance after import:", e);
      state.trades = trades.map((t) => ({ ...t, importId: importRecord.id }));
      state.balanceSnapshots = balancePoints.map((p) => ({
        ts: p.ts,
        dateKey: p.dateKey,
        balance: p.balance,
        importId: importRecord.id,
      }));
    }
    state.fileLoadInfo = { fileCount: parts.length, fillCount: fills.length };
    await hydrateTradeMeta();
    state.metrics = computeMetrics(state.trades);
    try {
      state.imports = await apiGetImports();
    } catch (e) {
      console.error("Failed to refresh imports:", e);
    }
    try {
      state.tradingAccounts = await apiGetAccounts();
    } catch (e) {
      console.error("Failed to refresh trading accounts:", e);
    }
    syncTradingAccountPickerState();
    // Keep tags visible: merge create response + form tags if GET omits or shapes tags oddly.
    if (importRecord.id && tags.length) {
      const fromCreate = importTagsAsArray(importRecord.tags);
      const mergedTags = fromCreate.length ? fromCreate : tags;
      const idx = state.imports.findIndex((im) => im.id === importRecord.id);
      if (idx === -1) {
        state.imports.unshift({
          ...importRecord,
          tags: mergedTags,
          broker,
          filename,
          account_id: importRecord.account_id ?? uploadId,
        });
      } else {
        const row = state.imports[idx];
        if (!importTagsAsArray(row.tags).length) {
          row.tags = mergedTags;
        }
      }
    }
    state.filesLabel = `Loaded ${parts.length} file(s) · ${fills.length} fills · ${trades.length} counted round trips`;
    if (trades.length) {
        state.calendarMonth = new Date(trades[0].closeTs);
    }
    state.selectedDay = null;
    if (isActivePage(Page.TradeImport)) {
        state.page = Page.Dashboard;
    }
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

  const tagInput = $("#dashboard-tag-input");
  if (tagInput) {
    tagInput.addEventListener("focusin", () => {
      cancelHideDashboardTagSuggestions();
      updateDashboardTagSuggestions();
    });
    tagInput.addEventListener("input", () => {
      updateDashboardTagSuggestions();
    });
    tagInput.addEventListener("keydown", onDashboardTagInputKeydown);
    tagInput.addEventListener("focusout", () => {
      scheduleHideDashboardTagSuggestions();
    });
  }

  $("#dashboard-tag-suggestions")?.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-dashboard-tag-suggest]")) e.preventDefault();
  });

  $("#dashboard-tag-suggestions")?.addEventListener("focusin", () => {
    cancelHideDashboardTagSuggestions();
  });

  $("#dashboard-tag-suggestions")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dashboard-tag-suggest]");
    if (!btn) return;
    const label = btn.getAttribute("data-dashboard-tag-suggest") || "";
    if (!label || !addDashboardTagFilter(label)) return;
    const inputEl = $("#dashboard-tag-input");
    if (inputEl) inputEl.value = "";
    hideDashboardTagSuggestions();
    render();
  });

  $("#dashboard-tag-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dashboard-tag-remove]");
    if (!btn) return;
    const rm = btn.getAttribute("data-dashboard-tag-remove");
    if (rm == null) return;
    state.dashboardTagFilters = (state.dashboardTagFilters || []).filter(
      (x) => x !== rm,
    );
    persistDashboardTagFilters();
    render();
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

  if (isActivePage(Page.Account)) {
    const emailEl = $("#account-email");
    if (emailEl) emailEl.textContent = localStorage.getItem("user_email") ?? "";
  
    $("#change-password-btn")?.addEventListener("click", async () => {
      const pwd = $("#new-password").value;
      const confirm = $("#confirm-password").value;
      const msg = $("#password-msg");
      if (pwd !== confirm) {
        msg.textContent = "Passwords do not match";
        msg.className = "text-sm text-loss";
        msg.classList.remove("hidden");
        return;
      }
      try {
        await apiChangePassword(pwd);
        msg.textContent = "Password updated";
        msg.className = "text-sm text-gain";
        msg.classList.remove("hidden");
      } catch (e) {
        msg.textContent = e.message;
        msg.className = "text-sm text-loss";
        msg.classList.remove("hidden");
      }
    });
  
    $("#delete-trades-btn")?.addEventListener("click", async () => {
      if (
        !confirm(
          "Delete all trades, import history, balance snapshots, and trading accounts? This cannot be undone.",
        )
      )
        return;
      try {
        await apiDeleteAllTrades();
        state.trades = [];
        state.metrics = null;
        state.balanceSnapshots = [];
        state.imports = [];
        state.tradingAccounts = [];
        state.uploadAccountId = "";
        state.displayAccountId = "";
        localStorage.removeItem(LS_UPLOAD_ACCOUNT);
        localStorage.removeItem(LS_DISPLAY_ACCOUNT);
        state.dashboardTagFilters = [];
        persistDashboardTagFilters();
        state.tradeMetaById.clear();
        state.screenshotUrls.clear();
        state.calendarDayNotes = {};
        persistCalendarDayNotes();
        closeCalendarDayNoteModal();
        state.filesLabel = "No files loaded";
        render();
      } catch (e) {
        alert(e.message);
      }
    });
  
    $("#delete-account-btn")?.addEventListener("click", async () => {
      if (!confirm("Delete your account and all data permanently?")) return;
      try {
        await apiDeleteAccount();
        logout();
      } catch (e) {
        alert(e.message);
      }
    });
  }

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

  const onCalendar = isActivePage(Page.Calendar);

  const { tradesView } = dashboardScope();
  const importsScope = importsInDisplayScope(
    state.imports,
    state.displayAccountId,
  );
  const balScoped = filteredBalanceSnapshotsByAccount(
    state.balanceSnapshots,
    state.imports,
    state.displayAccountId,
  );
  const balFiltered =
    state.dashboardTagFilters.length > 0
      ? filteredBalanceSnapshotsForTradesSubset(balScoped, tradesView)
      : balScoped;
  const equityFiltered = buildEquitySeries(balFiltered);

  let equitySlice = equityFiltered;
  let weekdayBars = computeMetrics(tradesView).byWeekday;
  let tradesForKpis = tradesView;

  if (onCalendar) {
    const d = state.calendarMonth;
    const y = d.getFullYear();
    const mo = d.getMonth();
    equitySlice = equitySeriesForMonth(equityFiltered, y, mo);
    tradesForKpis = tradesClosedInMonth(tradesView, y, mo);
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

  const cumSeries = onCalendar
    ? cumulativePnlDailySeries(tradesView, {
        y: state.calendarMonth.getFullYear(),
        mo: state.calendarMonth.getMonth(),
      })
    : cumulativePnlDailySeries(tradesView, null);
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

  const { tradesView: trades } = dashboardScope();
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

      const dayNoteRaw = state.calendarDayNotes[key] ?? "";
      const dayNote = dayNoteRaw.replace(/\r\n/g, "\n").trim();
      const hasDayNote = dayNote.length > 0;
      const noteBadgeClass = hasDayNote
        ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-500/40"
        : "bg-slate-800 text-slate-600 ring-1 ring-slate-700/80";
      const tipHtml = hasDayNote
        ? `<div class="cal-day-note-tip pointer-events-none absolute left-1/2 bottom-full z-30 mb-1 w-[min(18rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-slate-600 bg-slate-950/50 p-2 text-left text-[11px] leading-snug text-slate-200 shadow-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 max-h-36 overflow-y-auto whitespace-pre-wrap">${escapeHtml(dayNote)}</div>`
        : "";

      dayCells += `
        <button type="button" data-day="${key}"
          class="cal-cell group relative rounded-xl border text-left min-h-[4.75rem] sm:min-h-[5.75rem] transition-all active:opacity-90 hover:ring-1 hover:ring-accent/40 ${cardBg} ${sel ? "ring-2 ring-accent" : ""} ${inMonth ? "" : "opacity-55"}">
          <span class="absolute top-2 right-2 text-xs font-medium ${inMonth ? "text-slate-400" : "text-slate-600"}">${dom}</span>
          ${centerBlock}
          <span
            role="presentation"
            class="cal-day-note-btn absolute bottom-1.5 left-1.5 z-20 inline-flex h-7 w-7 items-center justify-center rounded text-[10px] font-semibold ${noteBadgeClass} pointer-events-auto hover:brightness-110"
            data-cal-day-note="${escapeAttr(key)}"
            title="${hasDayNote ? "Edit day comment" : "Add day comment"}"
          >N</span>
          ${tipHtml}
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
  grid.querySelectorAll(".cal-day-note-btn").forEach((badge) => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const k = badge.getAttribute("data-cal-day-note");
      if (k) openCalendarDayNoteModal(k);
    });
  });
}

let modalScreenshotDataUrl = null;
let modalCurrentId = null;
/** Per-trade tag list while trade modal is open (saved on Save). */
let modalTradeTagsDraft = [];
/** YYYY-MM-DD while calendar day note editor is open. */
let calendarDayNoteModalDateKey = null;

async function openModal(tradeId) {
  closeMetaPopover();
  closeMobileNav();
  closeCalendarDayNoteModal();
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
  const iid = normImportId(t.importId);
  modalImportEditId = iid || null;
  modalImportTagsDraft = iid
    ? normalizeTradeTagList(importTagsForTrade(t))
    : [];
  renderModalImportTagChips();
  const impAddIn = $("#modal-import-tag-add");
  if (impAddIn) impAddIn.value = "";
  modalTradeTagsDraft = normalizeTradeTagList(tradeMetaTagsNormalized(meta));
  renderModalTradeTagChips();
  const tagAddIn = $("#modal-trade-tag-add");
  if (tagAddIn) tagAddIn.value = "";
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
  closeScreenshotLightbox();
  $("#modal").classList.add("hidden");
  $("#modal").classList.remove("flex");
  modalCurrentId = null;
  modalScreenshotDataUrl = null;
  modalTradeTagsDraft = [];
  modalImportEditId = null;
  modalImportTagsDraft = [];
}

function openScreenshotLightbox(src) {
  if (!src || typeof src !== "string") return;
  const lb = $("#screenshot-lightbox");
  const big = $("#screenshot-lightbox-img");
  if (!lb || !big) return;
  big.src = src;
  big.alt = "Enlarged trade screenshot";
  lb.classList.remove("hidden");
  lb.classList.add("flex");
  lb.setAttribute("aria-hidden", "false");
}

function closeScreenshotLightbox() {
  const lb = $("#screenshot-lightbox");
  const big = $("#screenshot-lightbox-img");
  if (big) {
    big.removeAttribute("src");
    big.alt = "";
  }
  if (lb) {
    lb.classList.add("hidden");
    lb.classList.remove("flex");
    lb.setAttribute("aria-hidden", "true");
  }
}

function openCalendarDayNoteModal(dateKey) {
  const k = canonicalDateKey(dateKey);
  if (!k) return;
  calendarDayNoteModalDateKey = k;
  const el = $("#calendar-day-note-modal");
  const ta = $("#calendar-day-note-text");
  const dateLine = $("#calendar-day-note-modal-date");
  if (!el || !ta) return;
  const text = state.calendarDayNotes[k] ?? "";
  ta.value = text;
  if (dateLine) {
    try {
      const [yy, mm, dd] = k.split("-").map(Number);
      const d = new Date(yy, mm - 1, dd);
      dateLine.textContent = d.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      dateLine.textContent = k;
    }
  }
  el.classList.remove("hidden");
  el.classList.add("flex");
  el.setAttribute("aria-hidden", "false");
  queueMicrotask(() => ta.focus());
}

function closeCalendarDayNoteModal() {
  calendarDayNoteModalDateKey = null;
  const el = $("#calendar-day-note-modal");
  const ta = $("#calendar-day-note-text");
  if (ta) ta.value = "";
  if (el) {
    el.classList.add("hidden");
    el.classList.remove("flex");
    el.setAttribute("aria-hidden", "true");
  }
}

function saveCalendarDayNoteFromModal() {
  if (!calendarDayNoteModalDateKey) return;
  const k = canonicalDateKey(calendarDayNoteModalDateKey);
  if (!k) return;
  const raw = $("#calendar-day-note-text")?.value ?? "";
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  if (!trimmed) {
    delete state.calendarDayNotes[k];
  } else {
    state.calendarDayNotes[k] = trimmed;
  }
  apiPutDayNote(k, trimmed).catch((err) =>
    console.error("Failed to save day note:", err),
  );
  closeCalendarDayNoteModal();
  paintCalendar();
}

function clearCalendarDayNoteFromModal() {
  if (!calendarDayNoteModalDateKey) return;
  const k = canonicalDateKey(calendarDayNoteModalDateKey);
  if (!k) return;
  delete state.calendarDayNotes[k];
  apiPutDayNote(k, "").catch((err) =>
    console.error("Failed to clear day note:", err),
  );
  closeCalendarDayNoteModal();
  paintCalendar();
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
  closeScreenshotLightbox();
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
  const tags = normalizeTradeTagList(modalTradeTagsDraft);
  const patch = {
    id: modalCurrentId,
    notes: $("#modal-notes").value,
    tags,
  };
  if (rawRisk === "") {
    patch.riskPerShare = null;
  } else {
    const n = Number(rawRisk);
    if (Number.isFinite(n) && n >= 0) patch.riskPerShare = n;
  }

  try {
    if (modalImportEditId) {
      const importTags = normalizeTradeTagList(modalImportTagsDraft);
      const updatedImport = await apiUpdateImportTags(
        modalImportEditId,
        importTags,
      );
      const want = normImportId(modalImportEditId);
      const ix = state.imports.findIndex((r) => normImportId(r.id) === want);
      const mergedTags = updatedImport?.tags
        ? importTagsAsArray(updatedImport.tags)
        : importTags;
      if (ix >= 0) {
        state.imports[ix] = { ...state.imports[ix], tags: mergedTags };
      } else if (updatedImport?.id) {
        state.imports = [...(state.imports || []), updatedImport];
      }
    }

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
      tags: patch.tags,
    });

    const updated = {
      ...emptyTradeMeta(modalCurrentId),
      ...state.tradeMetaById.get(modalCurrentId),
      notes: patch.notes,
      riskPerShare: patch.riskPerShare ?? null,
      screenshotUrl,
      hasScreenshot: !!screenshotUrl,
      tags: patch.tags,
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
document.querySelector("#app")?.addEventListener("click", async (event) => {
  const sortTh = event.target.closest("th[data-trade-sort]");
  if (sortTh) {
    const col = sortTh.getAttribute("data-trade-sort");
    if (col && TRADE_TABLE_SORT_COLUMNS.has(col)) {
      if (state.tradeTableSort.column === col) {
        state.tradeTableSort.direction =
          state.tradeTableSort.direction === "asc" ? "desc" : "asc";
      } else {
        state.tradeTableSort.column = col;
        state.tradeTableSort.direction = defaultTradeSortDirection(col);
      }
      persistTradeTableSort();
      render();
    }
    return;
  }
  const delAcc = event.target.closest("[data-delete-trading-account]");
  if (delAcc) {
    const id = delAcc.getAttribute("data-delete-trading-account");
    if (!id) return;
    if (
      !confirm(
        "Delete this trading account? Only allowed when no CSV imports are linked to it.",
      )
    ) {
      return;
    }
    try {
      await apiDeleteTradingAccount(id);
      state.tradingAccounts = await apiGetAccounts();
      syncTradingAccountPickerState();
      render();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (event.target.closest("#add-trading-account-btn")) {
    const labelIn = $("#new-trading-account-label");
    const brokerIn = $("#new-trading-account-broker");
    if (!labelIn || !brokerIn) return;
    const label = String(labelIn.value || "").trim();
    if (!label) {
      alert("Enter an account label (e.g. Main taxable, IRA).");
      return;
    }
    try {
      const row = await apiCreateTradingAccount(label, brokerIn.value || "");
      state.tradingAccounts = await apiGetAccounts();
      syncTradingAccountPickerState();
      if (row?.id && !state.uploadAccountId) {
        state.uploadAccountId = String(row.id);
        localStorage.setItem(LS_UPLOAD_ACCOUNT, state.uploadAccountId);
      }
      labelIn.value = "";
      render();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const btn = event.target.closest("[data-nav-page]");
  if (!btn) return;
  const page = btn.dataset.navPage;
  if (!ALL_PAGE_IDS.includes(page)) return;
  closeMobileNav();
  state.page = page;
  render();
});

document.querySelector("#app")?.addEventListener("change", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLSelectElement)) return;
  if (t.id === "dashboard-display-account" || t.id === "display-account-select") {
    state.displayAccountId = (t.value || "").trim();
    if (state.displayAccountId) {
      localStorage.setItem(LS_DISPLAY_ACCOUNT, state.displayAccountId);
    } else {
      localStorage.removeItem(LS_DISPLAY_ACCOUNT);
    }
    render();
    return;
  }
  if (t.id === "upload-account-select") {
    state.uploadAccountId = (t.value || "").trim();
    if (state.uploadAccountId) {
      localStorage.setItem(LS_UPLOAD_ACCOUNT, state.uploadAccountId);
    } else {
      localStorage.removeItem(LS_UPLOAD_ACCOUNT);
    }
    render();
    return;
  }
  if (t.id === "trade-sort-column") {
    const col = String(t.value || "").trim();
    state.tradeTableSort.column = TRADE_TABLE_SORT_COLUMNS.has(col)
      ? col
      : "closeTs";
    persistTradeTableSort();
    render();
    return;
  }
  if (t.id === "trade-sort-direction") {
    state.tradeTableSort.direction = t.value === "asc" ? "asc" : "desc";
    persistTradeTableSort();
    render();
  }
});

document.addEventListener("click", onGlobalClickForTradeMenu);
document.addEventListener("click", (e) => {
  const t = e.target;
  const rmImp = t?.closest?.(".modal-import-tag-remove");
  if (rmImp && modalImportEditId && modalCurrentId) {
    const modal = $("#modal");
    if (modal && !modal.classList.contains("hidden")) {
      const enc = rmImp.getAttribute("data-remove-import-tag");
      if (enc == null) return;
      let tag;
      try {
        tag = decodeURIComponent(enc);
      } catch {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      modalImportTagsDraft = modalImportTagsDraft.filter((x) => x !== tag);
      renderModalImportTagChips();
      return;
    }
  }
  if (t?.closest?.("#modal-import-tag-add-btn") && modalImportEditId && modalCurrentId) {
    const modal = $("#modal");
    if (modal && !modal.classList.contains("hidden")) {
      e.preventDefault();
      addModalImportTagFromInput();
      return;
    }
  }
  const rmTag = t?.closest?.(".modal-trade-tag-remove");
  if (rmTag && modalCurrentId) {
    const modal = $("#modal");
    if (modal && !modal.classList.contains("hidden")) {
      const enc = rmTag.getAttribute("data-remove-tag");
      if (enc == null) return;
      let tag;
      try {
        tag = decodeURIComponent(enc);
      } catch {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      modalTradeTagsDraft = modalTradeTagsDraft.filter((x) => x !== tag);
      renderModalTradeTagChips();
      return;
    }
  }
  if (t?.closest?.("#modal-trade-tag-add-btn") && modalCurrentId) {
    const modal = $("#modal");
    if (modal && !modal.classList.contains("hidden")) {
      e.preventDefault();
      addModalTradeTagFromInput();
      return;
    }
  }
  if (t?.closest?.("#calendar-day-note-save")) {
    e.preventDefault();
    saveCalendarDayNoteFromModal();
    return;
  }
  if (t?.closest?.("#calendar-day-note-clear")) {
    e.preventDefault();
    clearCalendarDayNoteFromModal();
    return;
  }
  if (t?.closest?.("#calendar-day-note-cancel")) {
    e.preventDefault();
    closeCalendarDayNoteModal();
    return;
  }
  const cdnm = $("#calendar-day-note-modal");
  if (cdnm && !cdnm.classList.contains("hidden") && t === cdnm) {
    closeCalendarDayNoteModal();
    return;
  }
  if (t?.id === "modal-img" && t instanceof HTMLImageElement) {
    const src = t.currentSrc || t.src;
    if (src) {
      e.preventDefault();
      openScreenshotLightbox(src);
    }
    return;
  }
  if (t?.id === "screenshot-lightbox-close") {
    closeScreenshotLightbox();
    return;
  }
  const lb = $("#screenshot-lightbox");
  if (lb && !lb.classList.contains("hidden") && t === lb) {
    closeScreenshotLightbox();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (e.target?.id === "modal-import-tag-add") {
      e.preventDefault();
      addModalImportTagFromInput();
      return;
    }
    if (e.target?.id === "modal-trade-tag-add") {
      e.preventDefault();
      addModalTradeTagFromInput();
      return;
    }
  }
  if (e.key === "Enter" || e.key === " ") {
    const th = e.target?.closest?.("th[data-trade-sort]");
    if (th) {
      e.preventDefault();
      const col = th.getAttribute("data-trade-sort");
      if (col && TRADE_TABLE_SORT_COLUMNS.has(col)) {
        if (state.tradeTableSort.column === col) {
          state.tradeTableSort.direction =
            state.tradeTableSort.direction === "asc" ? "desc" : "asc";
        } else {
          state.tradeTableSort.column = col;
          state.tradeTableSort.direction = defaultTradeSortDirection(col);
        }
        persistTradeTableSort();
        render();
      }
      return;
    }
  }
  if (e.key !== "Escape") return;
  const shotLb = $("#screenshot-lightbox");
  if (shotLb && !shotLb.classList.contains("hidden")) {
    e.preventDefault();
    closeScreenshotLightbox();
    return;
  }
  const calNoteM = $("#calendar-day-note-modal");
  if (calNoteM && !calNoteM.classList.contains("hidden")) {
    e.preventDefault();
    closeCalendarDayNoteModal();
    return;
  }
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

if (!isPasswordRecovery) {
  if (!isLoggedIn()) {
    showAuthScreen();
  } else {
    apiGetTrades()
      .then(async (rows) => {
        let importRows = [];
        try {
          importRows = await apiGetImports();
        } catch (e) {
          console.error("Failed to load imports:", e);
        }
        state.imports = Array.isArray(importRows) ? importRows : [];
        try {
          state.tradingAccounts = await apiGetAccounts();
        } catch (e) {
          console.error("Failed to load trading accounts:", e);
          state.tradingAccounts = [];
        }
        const hasOrphanImports = state.imports.some(
          (im) => im.account_id == null || im.account_id === "",
        );
        if (hasOrphanImports && state.imports.length) {
          try {
            await apiBackfillTradingAccounts();
            state.imports = await apiGetImports();
            state.tradingAccounts = await apiGetAccounts();
          } catch (e) {
            console.warn("Trading account backfill skipped or failed:", e);
          }
        }
        syncTradingAccountPickerState();
        if (rows.length) {
          state.trades = rows.map((r) => ({
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
            importId: r.import_id ?? null,
          }));
          state.metrics = computeMetrics(state.trades);
          state.calendarMonth = new Date(
            state.trades[state.trades.length - 1].closeTs,
          );
          state.filesLabel = `${state.trades.length} trades loaded from database`;

          try {
            const balanceRows = await apiGetBalance();
            state.balanceSnapshots = balanceRows.length
              ? balanceRows.map((r) => ({
                  ts: r.ts,
                  dateKey: r.date_key,
                  balance: r.balance,
                  importId: r.import_id ?? null,
                }))
              : [];
          } catch (err) {
            console.error("Failed to load balance:", err);
            state.balanceSnapshots = [];
          }
        } else {
          state.trades = [];
          state.metrics = null;
          state.balanceSnapshots = [];
        }
        await hydrateTradeMeta();
        render();
      })
      .catch((err) => {
        console.error("Failed to load trades:", err);
        render();
      });
  }
}