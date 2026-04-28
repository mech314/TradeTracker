const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Coerce stored/API P&L to a number (avoids string values breaking sums). */
export function coercePnl(raw) {
  const v = Number(raw);
  return Number.isFinite(v) ? v : 0;
}

export function tradePnlNumber(t) {
  return coercePnl(t?.pnl);
}

/**
 * Normalize trade/API `date_key` to `YYYY-MM-DD` so maps line up with calendar
 * cells (`toDateKey`) even when the DB has `2025-4-5` instead of `2025-04-05`.
 */
export function canonicalDateKey(k) {
  if (k == null || k === "") return "";
  const s = String(k).trim();
  const padded = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (padded) return `${padded[1]}-${padded[2]}-${padded[3]}`;
  const loose = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (loose) {
    const [, y, mo, d] = loose;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return "";
}

export function computeMetrics(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => tradePnlNumber(t) > 0);
  const losses = trades.filter((t) => tradePnlNumber(t) < 0);
  const grossProfit = wins.reduce((s, t) => s + tradePnlNumber(t), 0);
  const grossLossAbs = Math.abs(
    losses.reduce((s, t) => s + tradePnlNumber(t), 0),
  );
  let profitFactor = null;
  if (grossLossAbs > 0) profitFactor = grossProfit / grossLossAbs;
  else if (grossProfit > 0) profitFactor = Infinity;

  const winRate = n ? wins.length / n : 0;

  const rpd = trades
    .map((t) => t.returnPerDollar)
    .filter((x) => x != null && Number.isFinite(x));
  const avgReturnPerDollar = rpd.length
    ? rpd.reduce((a, b) => a + b, 0) / rpd.length
    : null;

  const totalPnl = trades.reduce((s, t) => s + tradePnlNumber(t), 0);

  const byDayPnl = new Map();
  for (const t of trades) {
    const dk = canonicalDateKey(t.dateKey);
    if (!dk) continue;
    byDayPnl.set(dk, (byDayPnl.get(dk) || 0) + tradePnlNumber(t));
  }

  const byWeekday = WD.map((label, day) => ({
    day,
    label,
    count: 0,
    pnl: 0,
    wins: 0,
  }));
  for (const t of trades) {
    const d = new Date(t.closeTs).getDay();
    byWeekday[d].count += 1;
    byWeekday[d].pnl += tradePnlNumber(t);
    if (tradePnlNumber(t) > 0) byWeekday[d].wins += 1;
  }

  return {
    tradeCount: n,
    winCount: wins.length,
    lossCount: losses.length,
    winRate,
    profitFactor,
    avgReturnPerDollar,
    totalPnl,
    grossProfit,
    grossLossAbs,
    byDayPnl,
    byWeekday,
  };
}

export function formatPct(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(2)}%`;
}

export function formatUsd(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
