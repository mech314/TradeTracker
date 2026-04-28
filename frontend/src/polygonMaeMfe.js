/** Polygon.io MAE/MFE helpers (client). Backend proxies `/api/polygon/minute-aggs` to avoid CORS. */

export const POLYGON_THROTTLE_MS = 12000;

/** Polygon minute bars: `t` is window start (ms); bar covers [t, t + BAR_MS). */
export const POLYGON_BAR_MS = 60_000;

/** Local calendar date YYYY-MM-DD for Polygon `from`/`to`. */
export function formatDateYMDLocal(ms) {
  const d = new Date(Number(ms));
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * Skip Polygon only when the close falls on a **future** calendar day (bad clock/data).
 * Same-day closes are allowed so you can run MAE/MFE after importing today's session;
 * Polygon minute bars may still be filling until shortly after the close.
 */
export function shouldSkipPolygonIncompleteClose(closeTs) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const closeDay = new Date(Number(closeTs));
  closeDay.setHours(0, 0, 0, 0);
  return closeDay.getTime() > today.getTime();
}

/**
 * Dollar MAE/MFE over the hold window using peak position size (`maxShares`).
 * Note: if size scaled during the trade, using peak size can overstate early-session excursion vs path-dependent MAE.
 *
 * @param {Array<{ t?: number, T?: number, h?: number, high?: number, l?: number, low?: number }>} results Polygon minute bars (`t` = window start ms).
 */
export function computeMaeMfeDollars(openTs, closeTs, openSide, openPrice, maxShares, results) {
  if (
    !Number.isFinite(openPrice) ||
    openPrice <= 0 ||
    !Number.isFinite(maxShares) ||
    maxShares <= 0 ||
    !Array.isArray(results) ||
    !results.length
  ) {
    return null;
  }
  const isLong = String(openSide || "").toUpperCase().startsWith("L");
  const ots = Number(openTs);
  const cts = Number(closeTs);
  let mae = 0;
  let mfe = 0;
  let any = false;
  for (const bar of results) {
    const t = bar.t ?? bar.T;
    if (!Number.isFinite(t)) continue;
    // Overlap [t, t+BAR_MS) with [ots, cts] — not just t in range (open can fall mid-minute).
    if (t + POLYGON_BAR_MS <= ots || t > cts) continue;
    const hi = bar.h ?? bar.high;
    const lo = bar.l ?? bar.low;
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    any = true;
    let adv;
    let fav;
    if (isLong) {
      adv = Math.max(0, openPrice - lo);
      fav = Math.max(0, hi - openPrice);
    } else {
      adv = Math.max(0, hi - openPrice);
      fav = Math.max(0, openPrice - lo);
    }
    mae = Math.max(mae, adv * maxShares);
    mfe = Math.max(mfe, fav * maxShares);
  }
  if (!any) return null;
  return { mae, mfe };
}
