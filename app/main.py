import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi import HTTPException
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

if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
