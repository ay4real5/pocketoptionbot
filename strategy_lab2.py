"""Round 2: confluence + time-of-day + volatility filters, validated out-of-sample.

Train = first half of the history, Test = second half (never used for choosing rules).
Same strict scoring as strategy_lab.score.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import strategy_lab as L

SYMS = ["EURUSD", "GBPUSD", "AUDUSD", "USDJPY", "XAUUSD"]
BE = 52.9


def atr_pct(df, n=14):
    tr = pd.concat([df["high"] - df["low"], (df["high"] - df["close"].shift()).abs(), (df["low"] - df["close"].shift()).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean() / df["close"]


def strat_confluence(df, need=2):
    """Mean-reversion confluence: count of {RSI<30/>70, close outside Bollinger, 3 same-colour candles}."""
    c = df["close"]; r = L.rsi(c); m = c.rolling(20).mean(); sd = c.rolling(20).std()
    up = c > df["open"]; dn = c < df["open"]
    call_votes = (r < 30).astype(int) + (c < m - 2 * sd).astype(int) + (dn & dn.shift(1) & dn.shift(2)).astype(int)
    put_votes = (r > 70).astype(int) + (c > m + 2 * sd).astype(int) + (up & up.shift(1) & up.shift(2)).astype(int)
    return (call_votes >= need).astype(int) - (put_votes >= need).astype(int)


def strat_confluence3(df): return strat_confluence(df, 3)


def with_vol_filter(fn, low=True, q=0.5):
    """Only trade when ATR% is below (low=True) / above the rolling median."""
    def inner(df):
        a = atr_pct(df); med = a.rolling(288 * 5).quantile(q)  # ~1 trading week
        mask = (a < med) if low else (a > med)
        return fn(df).where(mask, 0).fillna(0).astype(int)
    return inner


CANDIDATES = {
    "RSI extreme revert": L.strat_rsi_extreme,
    "3-candle reversal": L.strat_three_candle_revert,
    "Bollinger revert": L.strat_bollinger_revert,
    "Confluence>=2": strat_confluence,
    "Confluence=3": strat_confluence3,
    "RSI revert, low-vol": with_vol_filter(L.strat_rsi_extreme, True),
    "RSI revert, high-vol": with_vol_filter(L.strat_rsi_extreme, False),
    "3-candle rev, low-vol": with_vol_filter(L.strat_three_candle_revert, True),
    "3-candle rev, high-vol": with_vol_filter(L.strat_three_candle_revert, False),
    "Confluence>=2, low-vol": with_vol_filter(strat_confluence, True),
}
EXPIRIES = [1, 3, 6, 12]
BLOCKS = [None, (0, 4), (4, 8), (8, 12), (12, 16), (16, 20), (20, 24)]


def evaluate(data, fn, bars, block):
    # blackout = every hour outside the allowed block
    blackout = [] if block is None else ([(0, block[0])] if block[0] > 0 else []) + ([(block[1], 24)] if block[1] < 24 else [])
    w = t = 0; pnl = 0.0
    for s, d in data.items():
        r = L.score(d, fn(d).fillna(0), bars, L.PAYOUT[s], blackout)
        t += r["trades"]; w += r["win_rate"] * r["trades"] / 100; pnl += r["pnl"]
    return t, (w / t * 100 if t else 0.0), pnl


def main():
    full = {s: L.load(s, 90, False) for s in SYMS}
    split = full["EURUSD"].index[len(full["EURUSD"]) // 2]
    train = {s: d[d.index < split] for s, d in full.items()}
    test = {s: d[d.index >= split] for s, d in full.items()}
    print(f"Train: {full['EURUSD'].index[0].date()} -> {split.date()}   Test: {split.date()} -> {full['EURUSD'].index[-1].date()}\n")

    results = []
    for name, fn in CANDIDATES.items():
        for bars in EXPIRIES:
            for block in BLOCKS:
                t, wr, pnl = evaluate(train, fn, bars, block)
                if t >= 150 and wr > BE + 1.5:  # must look good on TRAIN with a real sample
                    results.append((name, bars, block, t, wr, pnl))
    results.sort(key=lambda r: -r[4])
    print(f"Rules that beat {BE + 1.5:.1f}% on TRAIN (>=150 trades): {len(results)}\n")
    print(f"{'strategy':<24}{'exp':<5}{'hours UTC':<11}{'TRAIN n':>8}{'TRAIN%':>8}  |{'TEST n':>8}{'TEST%':>8}{'TEST pnl/100':>14}  verdict")
    survivors = 0
    for name, bars, block, t, wr, pnl in results[:25]:
        tt, twr, tpnl = evaluate(test, fn := CANDIDATES[name], bars, block)
        ok = tt >= 50 and twr > BE
        survivors += ok
        hb = "all" if block is None else f"{block[0]:02d}-{block[1]:02d}"
        print(f"{name:<24}{bars*5:<4}m{hb:<11}{t:>8}{wr:>8.1f}  |{tt:>8}{twr:>8.1f}{(tpnl / tt * 100 if tt else 0):>14.1f}  {'SURVIVES' if ok else 'fails'}")
    print(f"\nSurvivors on untouched TEST data: {survivors} of {min(25, len(results))}")


if __name__ == "__main__":
    main()
