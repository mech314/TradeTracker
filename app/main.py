import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from supabase import create_client, Client

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

app = FastAPI(title="TradeTracker")

@app.get("/api/health")
def health():
    return {"status": "ok"}

if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
