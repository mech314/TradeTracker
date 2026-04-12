import os
import uuid
import logging
from pathlib import Path
from typing import Optional
from pydantic import BaseModel
from supabase import create_client, Client

from fastapi import FastAPI, HTTPException, Depends, Security, UploadFile, File, Body
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials


logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

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
            "user": res.user.email
        }
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to login")

@app.get("/api/meta")
async def get_all_meta(user=Depends(get_current_user)):
    res = supabase.table("trade_meta").select("*").eq("user_id", user.id).execute()
    return res.data

@app.post("/api/meta")
async def upsert_meta(request: TradeMetaUpset, user=Depends(get_current_user)):
    res = supabase.table("trade_meta").upsert({
        "trade_id": request.trade_id,
        "notes": request.notes,
        "risk_per_share": request.risk_per_share,
        "screenshot_url": request.screenshot_url,
        "user_id": user.id
    }).execute()
    return res.data

@app.delete("/api/meta/{trade_id}")
async def delete_meta(trade_id: str, user=Depends(get_current_user)):
    res = supabase.table("trade_meta").delete().eq("trade_id", trade_id).eq("user_id", user.id).execute()
    return res.data

@app.post("/api/screenshots/upload")
async def upload_screenshot(file: UploadFile = File(...), user=Depends(get_current_user)):
    try:
        content = await file.read()
        ext = file.filename.split(".")[-1]
        filename = f"{user.id}/{uuid.uuid4()}.{ext}"
        supabase.storage.from_("screenshots").upload(
            filename,
            content,
            {"content-type": file.content_type}
        )
        url = supabase.storage.from_("screenshots").get_public_url(filename)
        return {"url": url}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/trades")
async def upsert_trades(trades: list[RoundTrip], user=Depends(get_current_user)):
    rows = [
        {
            "id": t.id,
            "user_id": user.id,
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
    res = supabase.table("round_trips").upsert(rows).execute()
    return res.data

@app.get("/api/trades")
async def get_trades(user=Depends(get_current_user)):
    res = supabase.table("round_trips").select("*").eq("user_id", user.id).order("close_ts").execute()
    return res.data

@app.delete("/api/trades/{trade_id}")
async def delete_trade(trade_id: str, user=Depends(get_current_user)):
    res = supabase.table("round_trips").delete().eq("id", trade_id).eq("user_id", user.id).execute()
    return res.data

@app.post("/api/auth/change-password")
async def change_password(body: dict = Body(...), user=Depends(get_current_user)):
    try:
        new_password = body.get("password")
        if not new_password or len(new_password) < 6:
            raise HTTPException(status_code=400, detail="Password too short")
        supabase.auth.admin.update_user_by_id(user.id, {"password": new_password})
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
    supabase.table("round_trips").delete().eq("user_id", user.id).execute()
    supabase.table("trade_meta").delete().eq("user_id", user.id).execute()
    return {"message": "All trades and meta data deleted successfully"}

@app.delete("/api/account")
async def delete_account(user=Depends(get_current_user)):
    supabase.table("round_trips").delete().eq("user_id", user.id).execute()
    supabase.table("trade_meta").delete().eq("user_id", user.id).execute()
    supabase.storage.from_("screenshots").delete(f"{user.id}/")
    supabase.auth.admin.delete_user(user.id)
    return {"message": "Account deleted successfully"}

if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

