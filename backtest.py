"""Replay the live strategy over the candle history the feed keeps (~24h of 5m candles).

Outcome rule (conservative, mirrors a fixed-expiry binary option):
  - entry  = close of the candle on which the signal fires
  - exit   = close of the candle `expiry_minutes / candle_minutes` bars later
  - CALL wins if exit > entry, PUT wins if exit < entry, exact tie counts as a LOSS
  - P/L: win = +stake * payout_rate, loss = -stake
Session filter is ignored so the whole day is evaluated.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, List

import pandas as pd

import config
from signal_engine import SignalEngine

logger = logging.getLogger(__name__)

WINDOW = 100  # candles fed to the strategy at each step, same as the live scanner
CANDLE_MINUTES = int(config.CHART_TIMEFRAME.replace("m", ""))


def _run_asset(engine: SignalEngine, symbol: str, df: pd.DataFrame, stake: float, payout_rate: float) -> List[Dict]:
    trades: List[Dict] = []
    if df.empty:
        return trades
    if "isOpen" in df.columns:  # drop the still-forming candle
        df = df[df["isOpen"] != True].reset_index(drop=True)
    last_exit_idx = -1
    for i in range(WINDOW, len(df)):
        if i <= last_exit_idx:  # one trade per asset at a time, like auto-simulation
            continue
        window = df.iloc[i - WINDOW:i]
        when = pd.to_datetime(window["time"].iloc[-1], utc=True).to_pydatetime() if "time" in window else datetime.now(timezone.utc)
        sig = engine.evaluate(symbol, window, now=when)
        if not sig:
            continue
        bars = max(1, sig.expiry_minutes // CANDLE_MINUTES)
        exit_idx = i - 1 + bars
        if exit_idx >= len(df):
            break
        entry = float(window["close"].iloc[-1])
        exit_price = float(df["close"].iloc[exit_idx])
        win = exit_price > entry if sig.direction == "CALL" else exit_price < entry
        trades.append({
            "asset": symbol,
            "time": when.isoformat(),
            "direction": sig.direction,
            "strength": sig.strength,
            "entry": entry,
            "exit": exit_price,
            "result": "win" if win else "loss",
            "pnl": round(stake * payout_rate, 2) if win else -stake,
        })
        last_exit_idx = exit_idx
    return trades


def _summary(trades: List[Dict]) -> Dict:
    wins = sum(1 for t in trades if t["result"] == "win")
    total = len(trades)
    return {
        "total": total,
        "wins": wins,
        "losses": total - wins,
        "win_rate": round(wins / total * 100, 1) if total else 0.0,
        "profit": round(sum(t["pnl"] for t in trades), 2),
    }


def run_backtest(engine: SignalEngine, symbols=None, stake: float = config.DEFAULT_STAKE) -> Dict:
    symbols = symbols or list(config.ASSETS)
    all_trades: List[Dict] = []
    per_asset: Dict[str, Dict] = {}
    per_strength: Dict[int, List[Dict]] = {}
    candles_used: Dict[str, int] = {}
    for symbol in symbols:
        try:
            df = engine.fetch_ohlc(symbol, config.CHART_TIMEFRAME, limit=1000)
        except Exception as exc:
            logger.warning("Backtest: could not fetch %s: %s", symbol, exc)
            continue
        candles_used[symbol] = len(df)
        payout = float(config.ASSETS[symbol].get("payout", 0.90))
        trades = _run_asset(engine, symbol, df, stake, payout)
        per_asset[symbol] = _summary(trades)
        for t in trades:
            per_strength.setdefault(t["strength"], []).append(t)
        all_trades.extend(trades)
    breakeven = None
    if all_trades:
        avg_payout = sum(t["pnl"] for t in all_trades if t["result"] == "win") / max(1, sum(1 for t in all_trades if t["result"] == "win")) / stake if any(t["result"] == "win" for t in all_trades) else 0.90
        breakeven = round(100 / (1 + avg_payout), 1) if avg_payout else None
    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "overall": _summary(all_trades),
        "breakeven_win_rate": breakeven,
        "per_asset": per_asset,
        "per_strength": {str(k): _summary(v) for k, v in sorted(per_strength.items())},
        "candles_used": candles_used,
        "trades": all_trades[-200:],
        "note": "Feed keeps ~24h of history; this is a same-day replay, not proof of an edge.",
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import json
    print(json.dumps(run_backtest(SignalEngine()), indent=2, default=str)[:6000])
