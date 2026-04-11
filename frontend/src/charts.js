import Chart from "chart.js/auto";

export function destroyChart(canvas) {
  const c = Chart.getChart(canvas);
  if (c) c.destroy();
}

const grid = "rgba(148, 163, 184, 0.12)";
const text = "rgba(226, 232, 240, 0.85)";

Chart.defaults.color = text;
Chart.defaults.borderColor = grid;

/** Sparkline of cumulative realized P&amp;L (running sum of round-trip P&amp;L by close date). */
export function renderCumulativeReturnSparkline(canvas, series) {
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  if (!series.length) return null;

  const labels = series.map((p) => p.dateKey);
  const data = series.map((p) => p.cumulative);

  return new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: "rgba(167, 139, 250, 0.95)",
          backgroundColor: "rgba(167, 139, 250, 0.18)",
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label ?? "",
            label: (ctx) =>
              `Cumulative: $${Number(ctx.raw).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          },
        },
      },
      scales: {
        x: {
          display: false,
          grid: { display: false },
        },
        y: {
          display: false,
          grid: { display: false },
        },
      },
    },
  });
}

export function renderEquityChart(canvas, series) {
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  if (!series.length) return null;

  const labels = series.map((p) => p.dateKey);
  const data = series.map((p) => p.balance);

  return new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Account balance (EOD)",
          data,
          borderColor: "#3d8bfd",
          backgroundColor: "rgba(61, 139, 253, 0.15)",
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `$${Number(ctx.raw).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8 } },
        y: {
          ticks: {
            callback: (v) =>
              "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }),
          },
        },
      },
    },
  });
}

export function renderWeekdayChart(canvas, byWeekday) {
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();

  const order = [1, 2, 3, 4, 5, 0, 6];
  const labels = order.map((d) => byWeekday[d].label);
  const pnls = order.map((d) => byWeekday[d].pnl);
  const colors = pnls.map((p) =>
    p > 0 ? "rgba(52, 211, 153, 0.75)" : p < 0 ? "rgba(248, 113, 113, 0.75)" : "rgba(148, 163, 184, 0.5)",
  );

  return new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "P&L by close weekday",
          data: pnls,
          backgroundColor: colors,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `$${Number(ctx.raw).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          ticks: {
            callback: (v) =>
              "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }),
          },
        },
      },
    },
  });
}
