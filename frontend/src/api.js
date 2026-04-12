import { getToken } from "./auth.js";

const API = "";

function authHeaders() {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`
    };
}

// --- Trade Meta ---

export async function apiGetAllMeta() {
    const res = await fetch(`${API}/api/meta`, {
        headers: authHeaders()
    });
    if (!res.ok) throw new Error("Failed to fetch meta");
    return res.json();
}

export async function apiUpsertMeta(record) {
    const res = await fetch(`${API}/api/meta`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
            trade_id: record.id,
            notes: record.notes ?? null,
            risk_per_share: record.riskPerShare ?? null,
            screenshot_url: record.screenshotUrl ?? null,
        })
    });
    if (!res.ok) throw new Error("Failed to save meta");
    return res.json();
}

export async function apiDeleteMeta(tradeId) {
    const res = await fetch(`${API}/api/meta/${encodeURIComponent(tradeId)}`, {
        method: "DELETE",
        headers: authHeaders()
    });
    if (!res.ok) throw new Error("Failed to delete meta");
    return res.json();
}

// --- Screenshots ---

export async function apiUploadScreenshot(file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API}/api/screenshots/upload`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${getToken()}`
        },
        body: formData
    });
    if (!res.ok) throw new Error("Failed to upload screenshot");
    const data = await res.json();
    return data.url;
}