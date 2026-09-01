"""Flask web dashboard for Pocket Option signal assistant."""

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone

import pandas as pd
from flask import Flask, jsonify, render_template, request

import config
from signal_engine import SignalEngine, Signal
from simulator import Simulator
from telegram_alerts import TelegramAlerter
from trades import SignalLog, TradeJournal

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(config.LOG_DIR, "dashboard.log"), mode="a"),
    ],
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
engine = SignalEngine()
journal = TradeJournal()
signal_log = SignalLog()
alerter = TelegramAlerter()
simulator = Simulator()

# In-memory state (single-user local dashboard)
state = {
    "signals": [],           # list of latest signals per asset
    "active_signal": None,   # signal currently shown for manual execution
    "last_scan": None,
    "scanning": False,
    "last_alert": {},        # asset+direction -> last alert timestamp
}


def signal_to_dict(signal: Signal) -> dict:
    d = signal.to_dict()
    d["signal_id"] = str(uuid.uuid4())[:8]
    return d


def should_alert(symbol: str, direction: str) -> bool:
    """Throttle repeated alerts for the same asset+direction."""
    key = f"{symbol}:{direction}"
    last = state["last_alert"].get(key)
    now = datetime.now(timezone.utc)
    if last is None:
        return True
    if (now - last).total_seconds() >= config.SIGNAL_COOLDOWN_SECONDS:
        return True
    return False


def record_alert(symbol: str, direction: str):
    state["last_alert"][f"{symbol}:{direction}"] = datetime.now(timezone.utc)


def scan_once():
    """Fetch data once and update signal state."""
    if state["scanning"]:
        return
    try:
        state["scanning"] = True
        signals = []
        for symbol in config.ASSETS:
            sig = engine.generate_signal(symbol)
            if sig:
                sdict = signal_to_dict(sig)
                signals.append(sdict)
                if should_alert(symbol, sdict["direction"]):
                    signal_log.append(sdict)
                    alerter.send_signal(sdict)
                    record_alert(symbol, sdict["direction"])
                    logger.info("Signal generated for %s: %s %s (strength %s)",
                                symbol, sdict["direction"], sdict["label"], sdict["strength"])
                else:
                    logger.info("Signal for %s suppressed by cooldown", symbol)
        state["signals"] = signals
        state["last_scan"] = datetime.now(timezone.utc).isoformat()
        if signals:
            # Keep the strongest signal as the active one
            best = max(signals, key=lambda s: s["strength"])
            # Safety: pause new active signals if max consecutive losses reached
            if journal.analytics().get("trading_halted"):
                logger.warning("Trading halted: max consecutive losses reached")
                state["active_signal"] = None
            else:
                state["active_signal"] = best
    except Exception as exc:
        logger.exception("Scanner error: %s", exc)
    finally:
        state["scanning"] = False


def scanner_loop():
    """Background thread that periodically refreshes market data and signals."""
    while True:
        scan_once()
        time.sleep(config.SIGNAL_INTERVAL_SECONDS)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "last_scan": state["last_scan"],
        "scanning": state["scanning"],
        "assets": list(config.ASSETS.keys()),
        "asset_meta": config.ASSETS,
    })


@app.route("/api/signals")
def api_signals():
    return jsonify({
        "signals": state["signals"],
        "active_signal": state["active_signal"],
        "last_scan": state["last_scan"],
    })


@app.route("/api/analytics")
def api_analytics():
    return jsonify(journal.analytics())


@app.route("/api/chart/<symbol>")
def api_chart(symbol: str):
    df = engine.fetch_ohlc(symbol.upper(), config.CHART_TIMEFRAME, limit=60)
    if df.empty:
        return jsonify({"error": "no data"}), 404
    levels = engine.find_swing_levels(df, config.SWING_LOOKBACK)
    support = engine.nearest_level(float(df["close"].iloc[-1]), levels, "support")
    resistance = engine.nearest_level(float(df["close"].iloc[-1]), levels, "resistance")
    return jsonify({
        "symbol": symbol.upper(),
        "labels": [t.strftime("%H:%M") for t in df["time"]],
        "prices": df["close"].tolist(),
        "support": round(support, 6) if support else None,
        "resistance": round(resistance, 6) if resistance else None,
    })


@app.route("/api/trades")
def api_trades():
    df = journal.get_trades()
    if df.empty:
        return jsonify([])
    records = df.to_dict(orient="records")
    # Replace NaN/NaT/empty with None for clean JSON
    for row in records:
        for k, v in row.items():
            if v != v or v is None or v == "":
                row[k] = None
    return jsonify(records)


@app.route("/api/export/trades")
def export_trades():
    df = journal.get_trades()
    if df.empty:
        return "No trades to export", 404
    csv_path = os.path.join(config.DATA_DIR, "trades_export.csv")
    df.to_csv(csv_path, index=False)
    return {"status": "exported", "path": csv_path}


@app.route("/api/take_trade", methods=["POST"])
def take_trade():
    """Log that the user manually took a signal on Pocket Option."""
    data = request.json or {}
    signal_id = data.get("signal_id")
    signal = data.get("signal", {})
    if not signal:
        return jsonify({"error": "signal required"}), 400

    trade = journal.open_trade(
        signal_id=signal_id or str(uuid.uuid4())[:8],
        asset=signal.get("asset"),
        direction=signal.get("direction"),
        entry_price=float(signal.get("current_price", 0)),
        stake=float(signal.get("suggested_stake", config.DEFAULT_STAKE)),
        expiry_minutes=int(signal.get("expiry_minutes", 5)),
    )
    return jsonify({"status": "logged", "trade": trade.to_dict()})


@app.route("/api/close_trade", methods=["POST"])
def close_trade():
    """Record the outcome of a manual trade."""
    data = request.json or {}
    signal_id = data.get("signal_id")
    result = data.get("result")
    payout = float(data.get("payout", 0))
    exit_price = data.get("exit_price")
    notes = data.get("notes", "")

    if not signal_id or result not in ("win", "loss", "void"):
        return jsonify({"error": "signal_id and result (win/loss/void) required"}), 400

    journal.close_trade(
        signal_id=signal_id,
        result=result,
        payout=payout,
        exit_price=float(exit_price) if exit_price is not None else None,
        notes=notes,
    )
    return jsonify({"status": "closed"})


@app.route("/api/simulate/trade", methods=["POST"])
def simulate_trade():
    """Open a hypothetical trade for the current active signal."""
    data = request.json or {}
    signal = data.get("signal", state.get("active_signal"))
    if not signal:
        return jsonify({"error": "no signal"}), 400
    trade = simulator.open_trade(signal)
    return jsonify({"status": "simulated", "trade": trade.to_dict()})


@app.route("/api/simulate/resolve", methods=["POST"])
def simulate_resolve():
    """Resolve all open hypothetical trades whose expiry has passed."""
    simulator.resolve_open_trades()
    return jsonify({"status": "resolved", "analytics": simulator.analytics()})


@app.route("/api/simulate/analytics")
def simulate_analytics():
    return jsonify(simulator.analytics())


@app.route("/api/refresh", methods=["POST"])
def refresh_now():
    """Force a manual market scan (runs in background)."""
    if not state["scanning"]:
        threading.Thread(target=scan_once, daemon=True).start()
    return jsonify({"status": "scanning"})


@app.route("/api/clear_active", methods=["POST"])
def clear_active():
    state["active_signal"] = None
    return jsonify({"status": "cleared"})


def start_background_scanner():
    t = threading.Thread(target=scanner_loop, daemon=True)
    t.start()


if __name__ == "__main__":
    logger.info("Starting Pocket Option signal dashboard...")
    start_background_scanner()
    app.run(host="127.0.0.1", port=5000, debug=False)
