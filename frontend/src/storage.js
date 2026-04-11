const DB_NAME = "TradeTrackerMeta";
const STORE_META = "tradeMeta";
const STORE_SHOTS = "tradeShots";
const VERSION = 2;

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SHOTS)) {
        db.createObjectStore(STORE_SHOTS, { keyPath: "tradeId" });
      }
    };
  });
}

export function emptyTradeMeta(id) {
  return {
    id,
    notes: "",
    riskPerShare: null,
    hasScreenshot: false,
    updatedAt: null,
    screenshot: null,
  };
}

/** Sync base64 data URL → bytes (fast path). */
export function dataUrlToBinaryParts(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URL");
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mimeMatch = header.match(/^data:(.*?)(;|$)/);
  const mime = mimeMatch?.[1] || "application/octet-stream";
  if (!/;base64/i.test(header)) {
    throw new Error("Not a base64 data URL");
  }
  const bin = atob(body);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { mime, buffer: u8.buffer };
}

/**
 * Any data URL / blob URL → { mime, buffer } for IndexedDB.
 * Uses fetch first (handles non-;base64; encodings); falls back to atob.
 */
export async function dataUrlToBinaryPartsAsync(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new Error("Expected a data: URL");
  }
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const buf = await blob.arrayBuffer();
    const mime = blob.type || "application/octet-stream";
    if (!buf || buf.byteLength === 0) {
      throw new Error("Empty image data");
    }
    return { mime, buffer: buf };
  } catch {
    return dataUrlToBinaryParts(dataUrl);
  }
}

export function binaryToDataUrl(mime, buffer) {
  const u8 = new Uint8Array(buffer);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  return `data:${mime || "image/png"};base64,${b64}`;
}

export async function loadTradeMeta(id) {
  const db = await openDb();
  const tx = db.transaction([STORE_META, STORE_SHOTS], "readonly");
  const raw = await idbReq(tx.objectStore(STORE_META).get(id));
  const base = raw
    ? { ...emptyTradeMeta(id), ...raw, id }
    : emptyTradeMeta(id);

  let screenshot = null;
  if (base.hasScreenshot) {
    const sh = await idbReq(tx.objectStore(STORE_SHOTS).get(id));
    if (sh?.data && sh.data.byteLength > 0) {
      screenshot = binaryToDataUrl(sh.mime, sh.data);
    }
  }
  if (
    !screenshot &&
    typeof base.screenshot === "string" &&
    base.screenshot.startsWith("data:")
  ) {
    screenshot = base.screenshot;
  }
  if (
    !screenshot &&
    base.screenshot instanceof Blob &&
    base.screenshot.size > 0
  ) {
    screenshot = await blobToDataUrl(base.screenshot);
  }

  const { screenshot: _drop, ...rest } = base;
  return { ...rest, screenshot, hasScreenshot: !!screenshot };
}

/** All trades with notes/meta; screenshots resolved (sequential). */
export async function loadAllTradeMeta() {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  const raws = await idbReq(tx.objectStore(STORE_META).getAll());
  const rows = raws || [];
  const out = [];
  for (const raw of rows) {
    if (!raw?.id) continue;
    out.push(await loadTradeMeta(raw.id));
  }
  return out;
}

export async function deleteTradeMeta(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_SHOTS], "readwrite");
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve();
    tx.objectStore(STORE_META).delete(id);
    tx.objectStore(STORE_SHOTS).delete(id);
  });
}

export async function saveTradeMeta(record) {
  const id = record.id;
  const existing = await loadTradeMeta(id);
  let merged = { ...existing, ...record, id };
  for (const k of Object.keys(record)) {
    if (record[k] === undefined) delete merged[k];
  }
  merged.updatedAt = Date.now();

  const touchedShot = Object.prototype.hasOwnProperty.call(record, "screenshot");
  const clearShot = touchedShot && record.screenshot === null;
  const dataUrl =
    typeof merged.screenshot === "string" && merged.screenshot.startsWith("data:")
      ? merged.screenshot
      : null;

  let prepared = null;
  if (!clearShot && dataUrl) {
    try {
      prepared = await dataUrlToBinaryPartsAsync(dataUrl);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_SHOTS], "readwrite");
    const metaSt = tx.objectStore(STORE_META);
    const shotSt = tx.objectStore(STORE_SHOTS);

    tx.onerror = () => reject(tx.error);

    if (clearShot) {
      shotSt.delete(id);
      merged.hasScreenshot = false;
    } else if (prepared?.buffer?.byteLength > 0) {
      shotSt.put({
        tradeId: id,
        mime: prepared.mime,
        data: prepared.buffer,
      });
      merged.hasScreenshot = true;
    }

    const forMeta = { ...merged };
    delete forMeta.screenshot;
    const putReq = metaSt.put(forMeta);
    putReq.onerror = () => reject(putReq.error);

    tx.oncomplete = async () => {
      try {
        resolve(await loadTradeMeta(id));
      } catch (e) {
        reject(e);
      }
    };
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl) {
  const { mime, buffer } = await dataUrlToBinaryPartsAsync(dataUrl);
  return new Blob([buffer], { type: mime });
}
