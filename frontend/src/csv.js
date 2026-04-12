export function splitCSVLine(line) {
  const row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  return row;
}

export function parseMoney(s) {
  if (s == null || s === "") return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "~") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Coerce values from CSV, PostgREST, etc. to a finite number, or null. */
export function coerceNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "~") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
