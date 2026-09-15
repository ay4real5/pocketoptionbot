"""Diagnostic: which signal ingredients actually predict wins in the 24h replay."""
import logging
from collections import defaultdict

import pandas as pd

import config
from signal_engine import SignalEngine
import backtest

logging.basicConfig(level=logging.WARNING)
engine = SignalEngine()
W = backtest.WINDOW
rows = []
for symbol in config.ASSETS:
    df = engine.fetch_ohlc(symbol, config.CHART_TIMEFRAME, limit=1000)
    if "isOpen" in df.columns:
        df = df[df["isOpen"] != True].reset_index(drop=True)
    last_exit = -1
    for i in range(W, len(df)):
        if i <= last_exit:
            continue
        win = df.iloc[i - W:i]
        when = pd.to_datetime(win["time"].iloc[-1], utc=True).to_pydatetime()
        sig = engine.evaluate(symbol, win, now=when)
        if not sig:
            continue
        exit_idx = i - 1 + max(1, sig.expiry_minutes // backtest.CANDLE_MINUTES)
        if exit_idx >= len(df):
            break
        entry = float(win["close"].iloc[-1]); ex = float(df["close"].iloc[exit_idx])
        level = sig.support if sig.direction == "CALL" else sig.resistance
        dist_ratio = abs(entry - level) / entry / config.SR_TOUCH_THRESHOLD_PCT
        # did price already break through the level? (CALL below support / PUT above resistance)
        broke = (entry < level) if sig.direction == "CALL" else (entry > level)
        prev_close = float(win["close"].iloc[-2])
        last_move = (entry - prev_close) / entry
        rows.append({
            "asset": symbol, "dir": sig.direction, "strength": sig.strength,
            "dist_bucket": f"{min(int(dist_ratio * 3), 3)}/3",
            "broke_level": broke,
            "macd": "confirms" if "(confirms)" in sig.reason else ("disagrees" if "(disagrees)" in sig.reason else "flat"),
            "rsi_extreme": "RSI" in sig.reason,
            "last_candle_with_trade": (last_move > 0) == (sig.direction == "CALL"),
            "hour": when.hour,
            "win": (ex > entry) if sig.direction == "CALL" else (ex < entry),
        })

d = pd.DataFrame(rows)
print(f"total {len(d)}  win rate {d.win.mean()*100:.1f}%\n")
for col in ["strength", "dist_bucket", "broke_level", "macd", "rsi_extreme", "last_candle_with_trade", "dir", "asset"]:
    g = d.groupby(col)["win"].agg(["count", "mean"])
    g["mean"] = (g["mean"] * 100).round(1)
    print(f"--- by {col}\n{g.to_string()}\n")
g = d.groupby(d.hour // 4 * 4)["win"].agg(["count", "mean"]); g["mean"] = (g["mean"] * 100).round(1)
print(f"--- by 4h block (UTC)\n{g.to_string()}\n")
g = d.groupby(["broke_level", "macd"])["win"].agg(["count", "mean"]); g["mean"] = (g["mean"] * 100).round(1)
print(f"--- broke_level x macd\n{g.to_string()}")
