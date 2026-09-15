"""Strategy lab: compare candidate 5m binary strategies on months of Dukascopy history.

Scoring is identical for every strategy and deliberately strict:
  entry = close of the signal candle, exit = close N candles later (N = expiry / 5m)
  CALL wins if exit > entry, PUT wins if exit < entry, tie = LOSS
  P/L per trade: win = +payout, loss = -1 (in units of stake)
  One trade at a time per asset (no overlapping entries).

Usage: python strategy_lab.py [--days 90] [--refresh]
Data is cached in data/hist/<SYMBOL>_5m.csv.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

import config

HIST_DIR = os.path.join(config.DATA_DIR, "hist")
DUKA_NAMES = {"EURUSD": "EUR/USD", "GBPUSD": "GBP/USD", "AUDUSD": "AUD/USD", "USDJPY": "USD/JPY", "XAUUSD": "XAU/USD"}
PAYOUT = {"EURUSD": 0.92, "GBPUSD": 0.90, "AUDUSD": 0.87, "USDJPY": 0.88, "XAUUSD": 0.88}
EXPIRIES = [1, 3]  # candles (5m, 15m)


# ---------------------------------------------------------------- data
def load(symbol: str, days: int, refresh: bool) -> pd.DataFrame:
    os.makedirs(HIST_DIR, exist_ok=True)
    path = os.path.join(HIST_DIR, f"{symbol}_5m.csv")
    if os.path.exists(path) and not refresh:
        df = pd.read_csv(path, parse_dates=["timestamp"], index_col="timestamp")
        if len(df) > days * 200:
            return df
    import dukascopy_python as dk
    end = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    start = end - timedelta(days=days)
    df = dk.fetch(DUKA_NAMES[symbol], dk.INTERVAL_MIN_5, dk.OFFER_SIDE_BID, start, end)
    df = df[~df.index.duplicated()].sort_index()
    df.to_csv(path)
    return df


# ---------------------------------------------------------------- indicators
def ema(s, n): return s.ewm(span=n, adjust=False).mean()

def rsi(s, n=14):
    d = s.diff(); up = d.clip(lower=0); dn = -d.clip(upper=0)
    rs = up.ewm(alpha=1 / n, adjust=False).mean() / dn.ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + rs)

def swing_levels(df, lb=12):
    """Most recent confirmed swing high/low (fractal with lb candles each side), shifted so it's known at entry."""
    hi, lo = df["high"], df["low"]
    is_high = hi == hi.rolling(2 * lb + 1, center=True).max()
    is_low = lo == lo.rolling(2 * lb + 1, center=True).min()
    res = hi.where(is_high).shift(lb).ffill()   # confirmed lb candles later
    sup = lo.where(is_low).shift(lb).ffill()
    return sup, res


# ---------------------------------------------------------------- strategies
# Each returns a Series of +1 (CALL), -1 (PUT), 0 (nothing), aligned with df, using only past data.
def strat_sr_bounce(df):
    """Baseline: what the live dashboard does (approx). Near S/R + EMA8/21 trend + RSI filter."""
    c = df["close"]; sup, res = swing_levels(df); e8, e21 = ema(c, 8), ema(c, 21); r = rsi(c)
    thr = config.SR_TOUCH_THRESHOLD_PCT
    call = ((c - sup).abs() / c <= thr) & (e8 > e21) & (r < 70)
    put = ((c - res).abs() / c <= thr) & (e8 < e21) & (r > 30)
    return call.astype(int) - put.astype(int)

def strat_rsi_extreme(df):
    """Mean reversion: RSI crosses back from an extreme."""
    r = rsi(df["close"])
    call = (r.shift(1) < 30) & (r >= 30)
    put = (r.shift(1) > 70) & (r <= 70)
    return call.astype(int) - put.astype(int)

def strat_bollinger_revert(df):
    """Close outside 20/2 Bollinger band, then a candle closing back inside."""
    c = df["close"]; m = c.rolling(20).mean(); sd = c.rolling(20).std()
    up, lo = m + 2 * sd, m - 2 * sd
    call = (c.shift(1) < lo.shift(1)) & (c >= lo)
    put = (c.shift(1) > up.shift(1)) & (c <= up)
    return call.astype(int) - put.astype(int)

def strat_ema_pullback(df):
    """Trend continuation: EMA8>EMA21>EMA50, price dips to EMA21 and closes back above it (mirror for PUT)."""
    c, l, h = df["close"], df["low"], df["high"]; e8, e21, e50 = ema(c, 8), ema(c, 21), ema(c, 50)
    up_trend = (e8 > e21) & (e21 > e50); dn_trend = (e8 < e21) & (e21 < e50)
    call = up_trend & (l <= e21) & (c > e21) & (c > df["open"])
    put = dn_trend & (h >= e21) & (c < e21) & (c < df["open"])
    return call.astype(int) - put.astype(int)

def strat_three_candle_revert(df):
    """After 3 consecutive same-colour candles, bet on reversal."""
    up = df["close"] > df["open"]; dn = df["close"] < df["open"]
    call = dn & dn.shift(1) & dn.shift(2)
    put = up & up.shift(1) & up.shift(2)
    return call.astype(int) - put.astype(int)

def strat_three_candle_continue(df):
    s = strat_three_candle_revert(df)
    return -s

def strat_engulfing_at_sr(df):
    """Bullish engulfing candle at support / bearish engulfing at resistance."""
    o, c = df["open"], df["close"]; sup, res = swing_levels(df); thr = config.SR_TOUCH_THRESHOLD_PCT * 2
    bull = (c > o) & (c.shift(1) < o.shift(1)) & (c > o.shift(1)) & (o < c.shift(1))
    bear = (c < o) & (c.shift(1) > o.shift(1)) & (c < o.shift(1)) & (o > c.shift(1))
    call = bull & ((df["low"] - sup).abs() / c <= thr)
    put = bear & ((df["high"] - res).abs() / c <= thr)
    return call.astype(int) - put.astype(int)

def strat_sr_bounce_htf(df):
    """Baseline S/R bounce but only in the direction of the 1-hour trend (EMA 12 vs 36 on hourly closes)."""
    base = strat_sr_bounce(df)
    h = df["close"].resample("1h").last().dropna()
    htf = (ema(h, 12) > ema(h, 36)).astype(int) * 2 - 1
    htf = htf.reindex(df.index, method="ffill").shift(1)  # only completed hours
    return base.where(np.sign(base) == htf, 0).fillna(0).astype(int)

def strat_breakout(df):
    """Close breaks above the 20-candle high (CALL) / below the 20-candle low (PUT) with EMA50 agreement."""
    c = df["close"]; hh = df["high"].rolling(20).max().shift(1); ll = df["low"].rolling(20).min().shift(1); e50 = ema(c, 50)
    call = (c > hh) & (c > e50); put = (c < ll) & (c < e50)
    return call.astype(int) - put.astype(int)

STRATEGIES = {
    "S/R bounce (current)": strat_sr_bounce,
    "S/R bounce + 1h trend": strat_sr_bounce_htf,
    "Engulfing at S/R": strat_engulfing_at_sr,
    "RSI extreme revert": strat_rsi_extreme,
    "Bollinger revert": strat_bollinger_revert,
    "EMA pullback (trend)": strat_ema_pullback,
    "3-candle reversal": strat_three_candle_revert,
    "3-candle continuation": strat_three_candle_continue,
    "20-bar breakout": strat_breakout,
}


# ---------------------------------------------------------------- scoring
def score(df: pd.DataFrame, sig: pd.Series, bars: int, payout: float, blackout=()):
    c = df["close"].to_numpy(); s = sig.to_numpy(); hours = df.index.hour.to_numpy()
    n = len(c); i = 60; wins = losses = 0; pnl = 0.0; by_hour = {}
    while i < n - bars:
        if s[i] == 0 or any(a <= hours[i] < b for a, b in blackout):
            i += 1; continue
        entry, ex = c[i], c[i + bars]
        win = ex > entry if s[i] > 0 else ex < entry
        wins += win; losses += not win; pnl += payout if win else -1.0
        hb = by_hour.setdefault(hours[i] // 4 * 4, [0, 0]); hb[0] += win; hb[1] += 1
        i += bars  # no overlapping trades
    tot = wins + losses
    return {"trades": tot, "win_rate": wins / tot * 100 if tot else 0.0, "pnl": pnl, "by_hour": by_hour}


def run(days: int, refresh: bool, symbols):
    data = {s: load(s, days, refresh) for s in symbols}
    for s, d in data.items():
        print(f"{s}: {len(d)} candles {d.index[0]} -> {d.index[-1]}")
    print()
    rows = []
    for name, fn in STRATEGIES.items():
        sigs = {s: fn(d).fillna(0) for s, d in data.items()}
        for bars in EXPIRIES:
            agg_w = agg_t = 0; agg_pnl = 0.0; per_asset = {}; hours = {}
            for s, d in data.items():
                r = score(d, sigs[s], bars, PAYOUT[s])
                per_asset[s] = r; agg_t += r["trades"]; agg_w += r["win_rate"] * r["trades"] / 100; agg_pnl += r["pnl"]
                for h, (w, t) in r["by_hour"].items():
                    hb = hours.setdefault(h, [0, 0]); hb[0] += w; hb[1] += t
            wr = agg_w / agg_t * 100 if agg_t else 0
            rows.append({"strategy": name, "expiry": f"{bars*5}m", "trades": agg_t, "win_rate": round(wr, 1),
                         "pnl_per_100": round(agg_pnl / agg_t * 100, 1) if agg_t else 0,
                         "per_asset": {s: (r["trades"], round(r["win_rate"], 1)) for s, r in per_asset.items()},
                         "by_hour": {h: round(w / t * 100, 1) for h, (w, t) in sorted(hours.items()) if t >= 30}})
    avg_payout = np.mean([PAYOUT[s] for s in symbols]); be = 100 / (1 + avg_payout)
    print(f"Break-even win rate (avg payout {avg_payout:.2f}): {be:.1f}%   |  pnl_per_100 = stakes won/lost per 100 trades\n")
    rows.sort(key=lambda r: -r["pnl_per_100"])
    print(f"{'strategy':<26}{'exp':<6}{'trades':>7}{'win%':>7}{'pnl/100':>9}   per asset (trades, win%)")
    for r in rows:
        pa = "  ".join(f"{s}:{t}/{w}%" for s, (t, w) in r["per_asset"].items())
        print(f"{r['strategy']:<26}{r['expiry']:<6}{r['trades']:>7}{r['win_rate']:>7}{r['pnl_per_100']:>9}   {pa}")
    print("\nWin% by 4h UTC block for the top 3:")
    for r in rows[:3]:
        print(f"  {r['strategy']} {r['expiry']}: {r['by_hour']}")
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--days", type=int, default=90); ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--symbols", default="EURUSD,GBPUSD,AUDUSD,USDJPY,XAUUSD")
    a = ap.parse_args()
    run(a.days, a.refresh, a.symbols.split(","))
