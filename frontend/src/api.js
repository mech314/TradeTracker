import { getToken, setToken, getRefreshToken, setRefreshToken, logout } from "./auth.js";

const API = "";

function authHeaders() {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`
    };
}

function requestHeaders(options) {
    const merged = { ...authHeaders(), ...options.headers };
    // FormData must use multipart boundary; browser sets Content-Type when omitted.
    if (options.body instanceof FormData) delete merged["Content-Type"];
    return merged;
}

async function fetchWithRefresh(url, options = {}) {
    const res = await fetch(url, { ...options, headers: requestHeaders(options) });
    if (res.status === 401) {
        const refreshToken = getRefreshToken();
        if (!refreshToken) { logout(); return res; }
        const refreshRes = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        });
        if (!refreshRes.ok) { logout(); return res; }
        const data = await refreshRes.json();
        setToken(data.access_token);
        setRefreshToken(data.refresh_token);
        return fetch(url, { ...options, headers: requestHeaders(options) });
    }
    return res;
}

export async function apiGetAllMeta() {
    const res = await fetchWithRefresh(`${API}/api/meta`);
    if (!res.ok) throw new Error("Failed to fetch meta");
    return res.json();
}

export async function apiUpsertMeta(record) {
    const res = await fetchWithRefresh(`${API}/api/meta`, {
        method: "POST",
        body: JSON.stringify({
            trade_id: record.id,
            notes: record.notes ?? null,
            risk_per_share: record.riskPerShare ?? null,
            screenshot_url: record.screenshotUrl ?? null,
            tags: Array.isArray(record.tags) ? record.tags : [],
        })
    });
    if (!res.ok) throw new Error("Failed to save meta");
    return res.json();
}

export async function apiDeleteMeta(tradeId) {
    const res = await fetchWithRefresh(`${API}/api/meta/${encodeURIComponent(tradeId)}`, {
        method: "DELETE"
    });
    if (!res.ok) throw new Error("Failed to delete meta");
    return res.json();
}

export async function apiUploadScreenshot(file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetchWithRefresh(`${API}/api/screenshots/upload`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${getToken()}` },
        body: formData
    });
    if (!res.ok) throw new Error("Failed to upload screenshot");
    const data = await res.json();
    return data.url;
}

export async function apiUpsertTrades(trades, importId = null) {
    const res = await fetchWithRefresh(`${API}/api/trades`, {
        method: "POST",
        body: JSON.stringify(trades.map(t => ({
            id: t.id,
            import_id: importId ?? null,
            symbol: t.symbol,
            open_side: t.openSide,
            date_key: t.dateKey,
            open_ts: t.openTs,
            close_ts: t.closeTs,
            pnl: t.pnl,
            max_shares: t.maxShares,
            share_turnover: t.shareTurnover,
            two_way_notional: t.twoWayNotional,
            return_per_dollar: t.returnPerDollar,
        })))
    });
    if (!res.ok) throw new Error("Failed to save trades");
    return res.json();
}

export async function apiGetTrades() {
    const res = await fetchWithRefresh(`${API}/api/trades`);
    if (!res.ok) throw new Error("Failed to fetch trades");
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function apiDeleteTrade(tradeId) {
    const res = await fetchWithRefresh(`${API}/api/trades/${encodeURIComponent(tradeId)}`, {
        method: "DELETE"
    });
    if (!res.ok) throw new Error("Failed to delete trade");
    return res.json();
}

export async function apiChangePassword(password) {
    const res = await fetchWithRefresh(`${API}/api/auth/change-password`, {
        method: "POST",
        body: JSON.stringify({ password })
    });
    if (!res.ok) throw new Error("Failed to change password");
    return res.json();
}

export async function apiDeleteAllTrades() {
    const res = await fetchWithRefresh(`${API}/api/account/trades`, {
        method: "DELETE"
    });
    if (!res.ok) throw new Error("Failed to delete all trades");
    return res.json();
}

export async function apiDeleteAccount() {
    const res = await fetchWithRefresh(`${API}/api/account`, {
        method: "DELETE"
    });
    if (!res.ok) throw new Error("Failed to delete account");
    return res.json();
}

export async function apiUpsertBalance(snapshots, importId = null) {
    const params = new URLSearchParams();
    if (importId != null && String(importId).trim() !== "") {
        params.set("import_id", String(importId));
    }
    const qs = params.toString() ? `?${params}` : "";
    const res = await fetchWithRefresh(`${API}/api/balance${qs}`, {
        method: "POST",
        body: JSON.stringify(snapshots.map(s => ({
            ts: s.ts,
            date_key: s.dateKey,
            balance: s.balance,
            import_id: importId ?? null,
        })))
    });
    if (!res.ok) throw new Error("Failed to save balance");
    return res.json();
}

export async function apiGetBalance() {
    const res = await fetchWithRefresh(`${API}/api/balance`);
    if (!res.ok) throw new Error("Failed to fetch balance");
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function apiGetAccounts() {
    const res = await fetchWithRefresh(`${API}/api/accounts`);
    if (!res.ok) throw new Error("Failed to fetch trading accounts");
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function apiCreateTradingAccount(label, broker) {
    const res = await fetchWithRefresh(`${API}/api/accounts`, {
        method: "POST",
        body: JSON.stringify({ label, broker: broker || null }),
    });
    if (!res.ok) throw new Error("Failed to create trading account");
    const data = await res.json();
    if (Array.isArray(data)) return data[0] ?? null;
    return data ?? null;
}

export async function apiDeleteTradingAccount(accountId) {
    const res = await fetchWithRefresh(
        `${API}/api/accounts/${encodeURIComponent(accountId)}`,
        { method: "DELETE" },
    );
    if (!res.ok) throw new Error("Failed to delete trading account");
    return res.json();
}

/** Link orphan imports (no account_id) to per-broker legacy trading accounts. */
export async function apiBackfillTradingAccounts() {
    const res = await fetchWithRefresh(`${API}/api/accounts/backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
    if (!res.ok) throw new Error("Failed to backfill trading accounts");
    return res.json();
}

export async function apiCreateImport(broker, tags, filename, accountId = null) {
    const res = await fetchWithRefresh(`${API}/api/imports`, {
        method: "POST",
        body: JSON.stringify({
            broker,
            tags,
            filename,
            account_id: accountId ?? null,
        }),
    });
    if (!res.ok) throw new Error("Failed to create import");
    const data = await res.json();
    // PostgREST / Supabase insert returns an array of inserted rows.
    if (Array.isArray(data)) return data[0] ?? null;
    return data ?? null;
}

export async function apiUpdateImportTags(importId, tags) {
    const res = await fetchWithRefresh(
        `${API}/api/imports/${encodeURIComponent(String(importId).trim())}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags: tags ?? [] }),
        },
    );
    const rawText = await res.text();
    if (!res.ok) {
        let msg = rawText.trim() || `Failed to update import (${res.status})`;
        try {
            const errBody = JSON.parse(rawText);
            if (typeof errBody?.detail === "string") msg = errBody.detail;
            else if (errBody?.detail != null) msg = JSON.stringify(errBody.detail);
        } catch {
            /* plain text body */
        }
        throw new Error(msg.slice(0, 800));
    }
    try {
        return JSON.parse(rawText);
    } catch {
        return null;
    }
}

export async function apiGetImports() {
    const res = await fetchWithRefresh(`${API}/api/imports`);
    const rawText = await res.text();
    if (!res.ok) {
        let msg = rawText.trim() || `Failed to fetch imports (${res.status})`;
        try {
            const errBody = JSON.parse(rawText);
            if (typeof errBody?.detail === "string") msg = errBody.detail;
            else if (errBody?.detail != null) msg = JSON.stringify(errBody.detail);
        } catch {
            /* plain text body */
        }
        throw new Error(msg.slice(0, 800));
    }
    let data;
    try {
        data = JSON.parse(rawText);
    } catch {
        return [];
    }
    return Array.isArray(data) ? data : [];
}

export async function apiGetDayNotes() {
    const res = await apiFetch("/api/day-notes");
    if (!res.ok) throw new Error("Failed to fetch day notes");
    return res.json();
}

export async function apiPutDayNote(dateKey, note) {
    const res = await apiFetch(`/api/day-notes/${encodeURIComponent(dateKey)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) throw new Error("Failed to save day note");
    return res.json();
  }