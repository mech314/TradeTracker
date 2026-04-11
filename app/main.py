from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

app = FastAPI(title="TradeTracker")

if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
