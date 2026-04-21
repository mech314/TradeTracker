import os
import uuid
import logging
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, Field
from supabase import create_client, Client

from fastapi import FastAPI, HTTPException, Depends, Security, UploadFile, File, Body, Query
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from dotenv import load_dotenv
load_dotenv()


logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Anon (publishable) key: Auth API (sign-in, get_user(jwt), password reset email).
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
# Service role: PostgREST + Storage bypass RLS. Only use after get_current_user;
# always scope queries with .eq("user_id", user.id) (or equivalent).
supabase_admin: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

app = FastAPI(title="TradeTracker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer()

class TradeMetaUpset(BaseModel):
    trade_id: str
    notes: Optional[str] = None
    risk_per_share: Optional[float] = None
    screenshot_url: Optional[str] = None
    tags: list[str] = Field(default_factory=list)

class AuthRequest(BaseModel):
    email: str
    password: str

class RoundTrip(BaseModel):
    id: str
    symbol: str
    open_side: str
    date_key: str
    open_ts: int
    close_ts: int
    pnl: float
    max_shares: Optional[float] = None
    share_turnover: Optional[float] = None
    two_way_notional: Optional[float] = None
    return_per_dollar: Optional[float] = None
    import_id: Optional[str] = None

class BalanceSnapshot(BaseModel):
    ts: int
    date_key: str
    balance: float
    import_id: Optional[str] = None

class ImportCreate(BaseModel):
    broker: str
    tags: list[str] = []
    filename: Optional[str] = None
    account_id: Optional[str] = None


class ImportTagsUpdate(BaseModel):
    tags: list[str] = Field(default_factory=list)


class TradingAccountCreate(BaseModel):
    label: str
    broker: Optional[str] = None

class DayNotePutBody(BaseModel):
    note: str = ""


async def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    try:
        user = supabase.auth.get_user(token)
        return user.user
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid credentials")

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.post("/api/auth/register")
async def register(request: AuthRequest):
    try:
        res = supabase.auth.sign_up({
            "email": request.email,
            "password": request.password
        })
        return {"message": "Check your email to confirm registration"}
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to register")

@app.post("/api/auth/login")
async def login(body: AuthRequest):
    try:
        res = supabase.auth.sign_in_with_password({
            "email": body.email,
            "password": body.password
        })
        return {
            "access_token": res.session.access_token,
            "refresh_token": res.session.refresh_token,
            "user": res.user.email,
            "user_id": res.user.id
        }
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to login")

@app.get("/api/meta")
async def get_all_meta(user=Depends(get_current_user)):
    res = supabase_admin.table("trade_meta").select("*").eq("user_id", user.id).execute()
    return res.data

@app.post("/api/meta")
async def upsert_meta(request: TradeMetaUpset, user=Depends(get_current_user)):
    res = supabase_admin.table("trade_meta").upsert({
        "trade_id": request.trade_id,
        "notes": request.notes,
        "risk_per_share": request.risk_per_share,
        "screenshot_url": request.screenshot_url,
        "tags": [t.strip() for t in (request.tags or []) if str(t).strip()],
        "user_id": user.id
    }).execute()
    return res.data

@app.delete("/api/meta/{trade_id}")
async def delete_meta(trade_id: str, user=Depends(get_current_user)):
    res = supabase_admin.table("trade_meta").delete().eq("trade_id", trade_id).eq("user_id", user.id).execute()
    return res.data

@app.post("/api/screenshots/upload")
async def upload_screenshot(file: UploadFile = File(...), user=Depends(get_current_user)):
    try:
        content = await file.read()
        ext = file.filename.split(".")[-1]
        filename = f"{user.id}/{uuid.uuid4()}.{ext}"
        supabase_admin.storage.from_("screenshots").upload(
            filename,
            content,
            {"content-type": file.content_type}
        )
        url = supabase_admin.storage.from_("screenshots").get_public_url(filename)
        return {"url": url}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/trades")
async def upsert_trades(trades: list[RoundTrip], user=Depends(get_current_user)):
    rows = [
        {
            "id": t.id,
            "user_id": user.id,
            "import_id": t.import_id,
            "symbol": t.symbol,
            "open_side": t.open_side,
            "date_key": t.date_key,
            "open_ts": t.open_ts,
            "close_ts": t.close_ts,
            "pnl": t.pnl,
            "max_shares": t.max_shares,
            "share_turnover": t.share_turnover,
            "two_way_notional": t.two_way_notional,
            "return_per_dollar": t.return_per_dollar,
        }
        for t in trades
    ]
    res = supabase_admin.table("round_trips").upsert(rows).execute()
    return res.data

@app.get("/api/trades")
async def get_trades(user=Depends(get_current_user)):
    res = supabase_admin.table("round_trips").select("*").eq("user_id", user.id).order("close_ts").execute()
    return res.data

@app.delete("/api/trades/{trade_id}")
async def delete_trade(trade_id: str, user=Depends(get_current_user)):
    res = supabase_admin.table("round_trips").delete().eq("id", trade_id).eq("user_id", user.id).execute()
    return res.data

@app.post("/api/auth/change-password")
async def change_password(body: dict = Body(...), user=Depends(get_current_user)):
    try:
        new_password = body.get("password")
        if not new_password or len(new_password) < 6:
            raise HTTPException(status_code=400, detail="Password too short")
        supabase_admin.auth.admin.update_user_by_id(user.id, {"password": new_password})
        return {"message": "Password updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Change password error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/auth/forgot-password")
async def forgot_password(body: dict = Body(...)):
    try:
        email = body.get("email")
        supabase.auth.reset_password_email(email, {
            "redirect_to": "https://tradetracker-ryd7.onrender.com"
        })
        return {"message": "Recovery email sent"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/api/account/trades")
async def delete_all_trades(user=Depends(get_current_user)):
    """
    Remove all trading data for the user: round trips, meta, balance snapshots,
    and import rows (so import tags disappear). Order respects typical FKs
    (trades → imports, balance → imports).
    """
    supabase_admin.table("round_trips").delete().eq("user_id", user.id).execute()
    supabase_admin.table("trade_meta").delete().eq("user_id", user.id).execute()
    supabase_admin.table("balance_snapshots").delete().eq("user_id", user.id).execute()
    supabase_admin.table("imports").delete().eq("user_id", user.id).execute()
    try:
        supabase_admin.table("trading_accounts").delete().eq("user_id", user.id).execute()
    except Exception as e:
        logger.warning("trading_accounts cleanup for user %s: %s", user.id, e)
    return {
        "message": "All trades, meta, balance history, and import records (tags) deleted successfully",
    }

@app.delete("/api/account")
async def delete_account(user=Depends(get_current_user)):
    supabase_admin.table("round_trips").delete().eq("user_id", user.id).execute()
    supabase_admin.table("trade_meta").delete().eq("user_id", user.id).execute()
    supabase_admin.table("balance_snapshots").delete().eq("user_id", user.id).execute()
    supabase_admin.table("imports").delete().eq("user_id", user.id).execute()
    try:
        supabase_admin.table("trading_accounts").delete().eq("user_id", user.id).execute()
    except Exception as e:
        logger.warning("trading_accounts cleanup for user %s: %s", user.id, e)
    try:
        supabase_admin.storage.from_("screenshots").remove([f"{user.id}/"])
    except Exception as e:
        logger.warning("Storage cleanup for user %s: %s", user.id, e)
    supabase_admin.auth.admin.delete_user(user.id)
    return {"message": "Account deleted successfully"}

@app.post("/api/balance")
async def upsert_balance(
    snapshots: list[BalanceSnapshot],
    user=Depends(get_current_user),
    import_id: Optional[str] = Query(
        None,
        description="Import this upload belongs to; only those rows are replaced (other imports kept).",
    ),
):
    """
    Replace balance history for one import at a time. Older behavior deleted every
    snapshot for the user, which broke per-tag equity when multiple CSVs were loaded.
    """
    body_ids = {s.import_id for s in snapshots if s.import_id}
    if len(body_ids) > 1:
        raise HTTPException(
            status_code=400,
            detail="All balance snapshots in one request must share the same import_id",
        )
    body_import = next(iter(body_ids)) if body_ids else None
    if import_id and body_import and import_id != body_import:
        raise HTTPException(
            status_code=400,
            detail="import_id query parameter must match snapshot import_id fields",
        )
    scope = body_import or import_id

    if scope:
        supabase_admin.table("balance_snapshots").delete().eq("user_id", user.id).eq(
            "import_id", scope
        ).execute()
    elif snapshots:
        # Legacy: snapshots with no import_id — replace entire table for this user
        supabase_admin.table("balance_snapshots").delete().eq("user_id", user.id).execute()

    if not snapshots:
        return []

    rows = [
        {
            "user_id": user.id,
            "ts": s.ts,
            "date_key": s.date_key,
            "balance": s.balance,
            "import_id": s.import_id or scope,
        }
        for s in snapshots
    ]
    res = supabase_admin.table("balance_snapshots").insert(rows).execute()
    return res.data

@app.get("/api/balance")
async def get_balance(user=Depends(get_current_user)):
    all_rows = []
    page = 0
    page_size = 1000
    while True:
        res = (
            supabase_admin.table("balance_snapshots")
            .select("*")
            .eq("user_id", user.id)
            .order("ts")
            .range(page * page_size, (page + 1) * page_size - 1)
            .execute()
        )
        batch = res.data or []
        all_rows.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return all_rows

@app.post("/api/auth/refresh")
async def refresh_token(body: dict = Body(...)):
    try:
        res = supabase.auth.refresh_session(body.get("refresh_token"))
        return {
            "access_token": res.session.access_token,
            "refresh_token": res.session.refresh_token
        }
    except Exception as e:
        raise HTTPException(status_code=401, detail="Session expired")


@app.get("/api/accounts")
async def list_trading_accounts(user=Depends(get_current_user)):
    try:
        res = (
            supabase_admin.table("trading_accounts")
            .select("*")
            .eq("user_id", user.id)
            .execute()
        )
        rows = list(res.data or [])
        rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
        return rows
    except Exception as e:
        logger.exception("GET /api/accounts failed")
        raise HTTPException(
            status_code=500,
            detail=f"Could not load trading accounts: {e!s}",
        ) from e


@app.post("/api/accounts")
async def create_trading_account(body: TradingAccountCreate, user=Depends(get_current_user)):
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    broker = (body.broker or "").strip() or None
    try:
        res = supabase_admin.table("trading_accounts").insert(
            {
                "user_id": user.id,
                "label": label,
                "broker": broker,
            }
        ).execute()
        return res.data
    except Exception as e:
        logger.exception("POST /api/accounts failed")
        raise HTTPException(
            status_code=500,
            detail=f"Could not create trading account: {e!s}",
        ) from e


@app.post("/api/accounts/backfill")
async def backfill_trading_accounts(user=Depends(get_current_user)):
    """
    Imports created before trading accounts had `account_id` are orphans: broker
    lives on the import row but nothing appears in the trading-account dropdown.
    Create one `Legacy · {broker}` account per distinct orphan broker and set
    `imports.account_id`. Idempotent for already-linked imports.
    """
    uid = user.id
    try:
        imp_res = (
            supabase_admin.table("imports")
            .select("id", "broker", "account_id")
            .eq("user_id", uid)
            .execute()
        )
        imports_list = list(imp_res.data or [])
    except Exception as e:
        logger.exception("backfill: list imports")
        raise HTTPException(
            status_code=500,
            detail=f"Could not list imports for backfill: {e!s}",
        ) from e

    orphans = [r for r in imports_list if not r.get("account_id")]
    if not orphans:
        return {"linked": 0, "created_accounts": 0}

    try:
        ac_res = (
            supabase_admin.table("trading_accounts")
            .select("id", "label", "broker")
            .eq("user_id", uid)
            .execute()
        )
        accounts = list(ac_res.data or [])
    except Exception as e:
        logger.exception("backfill: list trading_accounts")
        raise HTTPException(
            status_code=500,
            detail=f"Could not list trading accounts: {e!s}",
        ) from e

    legacy_by_broker: dict[str, str] = {}
    for a in accounts:
        label = str(a.get("label") or "")
        b = (str(a.get("broker") or "").strip() or "Other")
        if label.startswith("Legacy ·"):
            legacy_by_broker.setdefault(b, a["id"])

    created = 0
    linked = 0
    for imp in orphans:
        broker = (str(imp.get("broker") or "").strip() or "Other")
        aid = legacy_by_broker.get(broker)
        if not aid:
            try:
                ins = supabase_admin.table("trading_accounts").insert(
                    {
                        "user_id": uid,
                        "label": f"Legacy · {broker}",
                        "broker": broker,
                    }
                ).execute()
            except Exception as e:
                logger.exception("backfill: insert trading_account")
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not create legacy trading account: {e!s}",
                ) from e
            row = (ins.data or [None])[0]
            if not row:
                continue
            aid = row["id"]
            legacy_by_broker[broker] = aid
            created += 1
        try:
            supabase_admin.table("imports").update({"account_id": aid}).eq(
                "id", imp["id"]
            ).eq("user_id", uid).execute()
        except Exception as e:
            logger.exception("backfill: update import")
            raise HTTPException(
                status_code=500,
                detail=f"Could not link import to trading account (ensure imports.account_id exists): {e!s}",
            ) from e
        linked += 1

    return {"linked": linked, "created_accounts": created}


@app.delete("/api/accounts/{account_id}")
async def delete_trading_account(account_id: str, user=Depends(get_current_user)):
    chk = (
        supabase_admin.table("imports")
        .select("id")
        .eq("user_id", user.id)
        .eq("account_id", account_id)
        .limit(1)
        .execute()
    )
    if chk.data:
        raise HTTPException(
            status_code=400,
            detail="This account still has CSV imports linked to it. Remove those imports (or delete all trades) before deleting the account.",
        )
    supabase_admin.table("trading_accounts").delete().eq("user_id", user.id).eq(
        "id", account_id
    ).execute()
    return {"ok": True}


@app.post("/api/imports")
async def create_import(body: ImportCreate, user=Depends(get_current_user)):
    insert_payload = {
        "user_id": user.id,
        "broker": body.broker,
        "tags": body.tags,
        "filename": body.filename,
    }
    if body.account_id:
        ok = (
            supabase_admin.table("trading_accounts")
            .select("id")
            .eq("user_id", user.id)
            .eq("id", body.account_id)
            .limit(1)
            .execute()
        )
        if not ok.data:
            raise HTTPException(
                status_code=400, detail="Unknown trading account for this user"
            )
        insert_payload["account_id"] = body.account_id
    res = supabase_admin.table("imports").insert(insert_payload).execute()
    return res.data

@app.get("/api/imports")
async def list_imports(user=Depends(get_current_user)):
    """
    List imports for the user. Uses select('*') and no server-side order so we
    do not depend on columns (e.g. created_at) that may be missing on older schemas.
    """
    try:
        res = (
            supabase_admin.table("imports")
            .select("*")
            .eq("user_id", user.id)
            .execute()
        )
        rows = list(res.data or [])
        # Sort in app if a timestamp exists; otherwise keep DB order.
        def _sort_ts(row: dict):
            for key in ("created_at", "inserted_at", "updated_at"):
                v = row.get(key)
                if v is not None:
                    return str(v)
            return ""

        rows.sort(key=_sort_ts, reverse=True)
        return rows
    except Exception as e:
        logger.exception("GET /api/imports failed")
        raise HTTPException(
            status_code=500,
            detail=f"Could not load imports: {e!s}",
        ) from e


@app.patch("/api/imports/{import_id}")
async def patch_import_tags(
    import_id: str, body: ImportTagsUpdate, user=Depends(get_current_user)
):
    """Update strategy tags for one CSV import (applies to all trades from that upload)."""
    tid = str(import_id).strip()
    if not tid:
        raise HTTPException(status_code=400, detail="Missing import id")
    tags_clean = [str(t).strip() for t in (body.tags or []) if str(t).strip()]
    uid = str(user.id)
    try:
        res = (
            supabase_admin.table("imports")
            .update({"tags": tags_clean})
            .eq("user_id", uid)
            .eq("id", tid)
            .execute()
        )
    except Exception as e:
        logger.exception("PATCH /api/imports/%s failed", tid)
        raise HTTPException(
            status_code=500,
            detail=f"Could not update import: {e!s}",
        ) from e
    data = res.data
    rows = data if isinstance(data, list) else ([data] if data else [])
    if not rows:
        raise HTTPException(status_code=404, detail="Import not found")
    return rows[0]

@app.get("/api/day-notes")
async def get_day_notes(user=Depends(get_current_user)):
    uid = str(user.id)
    try:
        res = (
            supabase_admin.table("calendar_day_notes")
            .select("date_key, note")
            .eq("user_id", uid)
            .execute()
        )
        rows = res.data or []
        return {r["date_key"]: r.get("note") or "" for r in rows}
    except Exception as e:
        logger.exception("GET /api/day-notes failed")
        raise HTTPException(
            status_code=500,
            detail=f"Could not load day notes: {e!s}",
        ) from e


@app.put("/api/day-notes/{date_key}")
async def put_day_note(
    date_key: str,
    body: DayNotePutBody,
    user=Depends(get_current_user),
):
    """Create/update or clear (empty body.note) a calendar day note."""
    uid = str(user.id)
    dk = str(date_key).strip()[:10]
    if len(dk) != 10 or dk[4] != "-" or dk[7] != "-":
        raise HTTPException(
            status_code=400,
            detail="Invalid date_key (expected YYYY-MM-DD)",
        )
    txt = (body.note or "").strip()
    try:
        if not txt:
            supabase_admin.table("calendar_day_notes").delete().eq(
                "user_id", uid
            ).eq("date_key", dk).execute()
            return {"date_key": dk, "note": ""}
        supabase_admin.table("calendar_day_notes").upsert(
            {
                "user_id": uid,
                "date_key": dk,
                "note": txt,
            }
        ).execute()
        return {"date_key": dk, "note": txt}
    except Exception as e:
        logger.exception("PUT /api/day-notes/%s failed", dk)
        raise HTTPException(
            status_code=500,
            detail=f"Could not save day note: {e!s}",
        ) from e


if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")