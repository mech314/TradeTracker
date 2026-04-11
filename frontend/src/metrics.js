const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function computeMetrics(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLossAbs = Math.abs(
    losses.reduce((s, t) => s + t.pnl, 0),
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

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  const byDayPnl = new Map();
  for (const t of trades) {
    byDayPnl.set(t.dateKey, (byDayPnl.get(t.dateKey) || 0) + t.pnl);
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
    byWeekday[d].pnl += t.pnl;
    if (t.win) byWeekday[d].wins += 1;
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
