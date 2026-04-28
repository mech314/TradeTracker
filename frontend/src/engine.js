import { splitCSVLine, parseMoney, coerceNumber } from "./csv.js";

const LINE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2}),(\d{2}:\d{2}:\d{2}),(TRD|BAL),/;
const TRADE_DESC_RE = /^(BOT|SOLD)\s+([+-]?\d+)\s+(\S+)\s@([\d.]+)/;

/**
 * Schwab journal date/time strings → Unix ms.
 * Interpreted as **local wall clock** in the browser (same as `formatTradeClock` / calendar cells).
 * Keep your OS timezone aligned with how the broker exports times (usually your account locale,
 * e.g. Mountain). If your CSV used Eastern-only timestamps without conversion, times would be wrong.
 */
function parseTs(dateStr, timeStr) {
  const [m, d, y] = dateStr.split("/").map(Number);
  const fullY = y < 50 ? 2000 + y : 1900 + y;
  const [hh, mm, ss] = timeStr.split(":").map(Number);
  return new Date(fullY, m - 1, d, hh, mm, ss || 0).getTime();
}

/** Calendar day key `YYYY-MM-DD` in **local** timezone — labels trades & Polygon `from`/`to` dates. */
function calendarKey(ts) {
  const x = new Date(ts);
  const y = x.getFullYear();
  const mo = String(x.getMonth() + 1).padStart(2, "0");
  const da = String(x.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** VWAP of legs that add to the opening position (same direction as final open side). */
export function computeAverageEntryPriceFromFills(bucket, openSide) {
  if (!bucket?.length) return null;
  const sign = String(openSide ?? "").toUpperCase().startsWith("L") ? 1 : -1;
  let q = 0;
  let sumPxQty = 0;
  let sumQty = 0;
  for (const leg of bucket) {
    const prevAbs = Math.abs(q);
    q += leg.qtyDelta;
    const abs = Math.abs(q);
    const openingLeg = Math.sign(leg.qtyDelta) === sign;
    const addsPosition =
      openingLeg && (abs > prevAbs || (prevAbs === 0 && abs > 0));
    if (addsPosition) {
      const dq = Math.abs(leg.qtyDelta);
      sumPxQty += dq * leg.price;
      sumQty += dq;
    }
  }
  if (sumQty <= 0) return bucket[0]?.price != null ? Number(bucket[0].price) : null;
  return sumPxQty / sumQty;
}

/**
 * Schwab cash journal: TRD rows with BOT/SOLD … @price and AMOUNT.
 */
export function extractFillsAndBalances(csvText) {
  const fills = [];
  const balancePoints = [];
  const lines = csvText.split(/\r?\n/);

  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, dateStr, timeStr, kind] = m;
    const row = splitCSVLine(line);
    if (row.length < 9) continue;

    const amount = parseMoney(row[7]);
    const balance = parseMoney(row[8]);

    const ts = parseTs(dateStr, timeStr);
    if (kind === "BAL" && balance != null) {
      balancePoints.push({ ts, dateKey: calendarKey(ts), balance });
      continue;
    }
    if (kind !== "TRD") continue;

    if (balance != null) {
      balancePoints.push({ ts, dateKey: calendarKey(ts), balance });
    }

    const desc = row[4] || "";
    const dm = desc.match(TRADE_DESC_RE);
    if (!dm) continue;

    const side = dm[1];
    const qtySigned = Number(dm[2]);
    const symbol = dm[3].toUpperCase();
    const price = Number(dm[4]);
    if (!Number.isFinite(qtySigned) || !symbol) continue;

    const qtyDelta = qtySigned;
    if (amount == null) continue;

    fills.push({
      ts,
      dateKey: calendarKey(ts),
      symbol,
      side,
      qtyDelta,
      price,
      amount,
      desc,
    });
  }

  fills.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
  balancePoints.sort((a, b) => a.ts - b.ts);
  return { fills, balancePoints };
}

/**
 * Per symbol: 0 → open → 0 round trip. Keep only if first and last fill same calendar day.
 * Discards open positions at end. Ignores cross-day round trips.
 */
export function buildRoundTripTrades(fills, userId) {
  const bySym = new Map();
  for (const f of fills) {
    if (!bySym.has(f.symbol)) bySym.set(f.symbol, []);
    bySym.get(f.symbol).push(f);
  }

  const trades = [];

  for (const [symbol, symFills] of bySym) {
    let qty = 0;
    let bucket = [];

    for (const f of symFills) {
      bucket.push(f);
      qty += f.qtyDelta;

      if (qty === 0 && bucket.length) {
        const first = bucket[0];
        const last = bucket[bucket.length - 1];
        if (first.dateKey === last.dateKey) {
          const pnl = bucket.reduce((s, x) => s + x.amount, 0);
          const grossCash = bucket.reduce((s, leg) => s + Math.abs(leg.amount), 0);
          const twoWayNotional = grossCash / 2;
          let run = 0;
          let maxAbsQty = 0;
          let sumAbsQtyDelta = 0;
          for (const leg of bucket) {
            sumAbsQtyDelta += Math.abs(leg.qtyDelta);
            run += leg.qtyDelta;
            maxAbsQty = Math.max(maxAbsQty, Math.abs(run));
          }
          const shareTurnover = sumAbsQtyDelta / 2;
          const openSide = first.qtyDelta > 0 ? "LONG" : "SHORT";
          const openPrice = computeAverageEntryPriceFromFills(bucket, openSide);
          trades.push({
            id: tradeId(symbol, first.ts, last.ts, bucket.length, userId),
            symbol,
            openSide,
            dateKey: last.dateKey,
            openTs: first.ts,
            closeTs: last.ts,
            pnl,
            openPrice,
            fills: bucket.slice(),
            twoWayNotional,
            maxShares: maxAbsQty,
            shareTurnover,
            userId,
            returnPerDollar:
              twoWayNotional > 0 ? pnl / twoWayNotional : null,
            win: pnl > 0,
          });
        }
        bucket = [];
      }

      if (qty < -1e6 || qty > 1e6) {
        qty = 0;
        bucket = [];
      }
    }
  }

  trades.sort((a, b) => b.closeTs - a.closeTs);
  return trades;
}

export function tradeId(symbol, openTs, closeTs, nLegs, userId) {
  return `${symbol}|${openTs}|${closeTs}|${nLegs}|${userId}`;
}

/** Fill count embedded in `tradeId` (bucket length when the trade was built). */
export function roundTripFillCountFromId(tradeId) {
  const parts = String(tradeId || "").split("|");
  const n = Number(parts[3]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * When `open_price` was never stored (older imports), infer VWAP entry for a **two-fill**
 * round trip from notional and P&amp;L (algebraically exact for flat size in/out).
 */
export function inferOpenPriceFromStoredRoundTrip(trade) {
  if (!trade) return null;
  if (roundTripFillCountFromId(trade.id) !== 2) return null;
  const Q = Number(trade.maxShares);
  const tw = Number(trade.twoWayNotional);
  const pnl = Number(trade.pnl);
  if (!Number.isFinite(Q) || Q <= 0 || !Number.isFinite(tw) || tw <= 0 || !Number.isFinite(pnl))
    return null;
  const long = String(trade.openSide || "").toUpperCase().startsWith("L");
  const half = pnl / (2 * Q);
  const mid = tw / Q;
  const inferred = long ? mid - half : mid + half;
  if (!Number.isFinite(inferred) || inferred <= 0) return null;
  return inferred;
}

/** Prefer persisted VWAP; otherwise infer for eligible two-fill trades. */
export function effectiveOpenPrice(trade) {
  const op = Number(trade?.openPrice);
  if (Number.isFinite(op) && op > 0) return op;
  const inferred = inferOpenPriceFromStoredRoundTrip(trade);
  return Number.isFinite(inferred) && inferred > 0 ? inferred : null;
}

export function buildEquitySeries(balancePoints) {
  if (!balancePoints.length) return [];
  const byDay = new Map();
  for (const p of balancePoints) {
    const balance = coerceNumber(p.balance);
    if (balance == null || !p.dateKey) continue;
    const prev = byDay.get(p.dateKey);
    const pt = { ts: p.ts, dateKey: p.dateKey, balance };
    if (!prev || pt.ts >= prev.ts) byDay.set(p.dateKey, pt);
  }
  const keys = [...byDay.keys()].sort();
  return keys.map((k) => ({ dateKey: k, balance: byDay.get(k).balance }));
}

export function calendarKeyFromTs(ts) {
  return calendarKey(ts);
}
