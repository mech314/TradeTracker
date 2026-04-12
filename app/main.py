import os
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Depends, Security
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import UploadFile, File
from pydantic import BaseModel
from typing import Optional
from supabase import create_client, Client


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

async def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    try:
        user = supabase.auth.get_user(token)
        return user.user
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid credentials")

class AuthRequest(BaseModel):
    email: str
    password: str

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

class TradeMetaUpset(BaseModel):
    trade_id: str
    notes: Optional[str] = None
    risk_per_share: Optional[float] = None
    screenshot: Optional[str] = None

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
        "screenshot": request.screenshot,
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
if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

