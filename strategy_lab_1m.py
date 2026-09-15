"""1-minute expiry strategy lab.

Tests the confluence strategy and 1m-specific approaches on 1-minute candles,
out-of-sample (train on first half, test on second half).

Key question: can any rule beat 52.9% break-even at 1-minute expiry?
"""
from __future__ import annotations
import os, numpy as np, pandas as pd
import strategy_lab as L

HIST_DIR = os.path.join("data", "hist")
SYMS_1M = ["EURUSD", "GBPUSD", "EURJPY", "CADJPY"]
BE = 52.9


def load_1m(symbol):
    path = os.path.join(HIST_DIR, f"{symbol}_1m.csv")
    df = pd.read_csv(path, parse_dates=["timestamp"], index_col="timestamp")
    return df[~df.index.duplicated()].sort_index()


def rsi(s, n=14):
    d = s.diff()
    g = d.where(d > 0, 0.0).ewm(alpha=1/n, adjust=False).mean()
    l = (-d).where(d < 0, 0.0).ewm(alpha=1/n, adjust=False).mean()
    return 100 - 100 / (1 + g / l.replace(0, 1e-12))


def bb(c, n=20, k=2):
    m = c.rolling(n).mean(); sd = c.rolling(n).std()
    return m, m + k*sd, m - k*sd


def strat_confluence(df, need=2, bb_n=20, bb_k=2, rsi_n=14, rsi_hi=70, rsi_lo=30, three_candles=3):
    """Mean-reversion confluence on 1m candles."""
    c = df["close"]; o = df["open"]
    r = rsi(c, rsi_n)
    _, up, lo = bb(c, bb_n, bb_k)
    up_c = c > o
    dn_c = c < o
    three_dn = dn_c & dn_c.shift(1) & dn_c.shift(2)
    three_up = up_c & up_c.shift(1) & up_c.shift(2)
    call = (r < rsi_lo).astype(int) + (c < lo).astype(int) + three_dn.astype(int)
    put = (r > rsi_hi).astype(int) + (c > up).astype(int) + three_up.astype(int)
    return (call >= need).astype(int) - (put >= need).astype(int)


def strat_confluence3(df):
    return strat_confluence(df, need=3)


def strat_rsi_extreme(df, rsi_n=14, lo=30, hi=70):
    r = rsi(df["close"], rsi_n)
    return (r < lo).astype(int) - (r > hi).astype(int)


def strat_bollinger(df, n=20, k=2):
    c = df["close"]; _, up, lo = bb(c, n, k)
    return (c < lo).astype(int) - (c > up).astype(int)


def strat_3candle_revert(df):
    c = df["close"]; o = df["open"]
    up = c > o; dn = c < o
    three_dn = dn & dn.shift(1) & dn.shift(2)
    three_up = up & up.shift(1) & up.shift(2)
    return three_dn.astype(int) - three_up.astype(int)


def strat_confluence_tight(df):
    """Confluence with tighter RSI (25/75) — fewer but stronger signals."""
    return strat_confluence(df, need=2, rsi_lo=25, rsi_hi=75)


def strat_confluence_very_tight(df):
    """Confluence with very tight RSI (20/80)."""
    return strat_confluence(df, need=2, rsi_lo=20, rsi_hi=80)


def strat_confluence_bb_tight(df):
    """Confluence with tight Bollinger (2.5 std)."""
    return strat_confluence(df, need=2, bb_k=2.5)


def strat_5candle_revert(df):
    """5 same-colour candles → fade."""
    c = df["close"]; o = df["open"]
    up = c > o; dn = c < o
    five_dn = dn & dn.shift(1) & dn.shift(2) & dn.shift(3) & dn.shift(4)
    five_up = up & up.shift(1) & up.shift(2) & up.shift(3) & up.shift(4)
    return five_dn.astype(int) - five_up.astype(int)


def strat_confluence_5candle(df):
    """Confluence but using 5-candle streak instead of 3."""
    c = df["close"]; o = df["open"]
    r = rsi(c)
    _, up, lo = bb(c)
    up_c = c > o; dn_c = c < o
    five_dn = dn_c & dn_c.shift(1) & dn_c.shift(2) & dn_c.shift(3) & dn_c.shift(4)
    five_up = up_c & up_c.shift(1) & up_c.shift(2) & up_c.shift(3) & up_c.shift(4)
    call = (r < 30).astype(int) + (c < lo).astype(int) + five_dn.astype(int)
    put = (r > 70).astype(int) + (c > up).astype(int) + five_up.astype(int)
    return (call >= 2).astype(int) - (put >= 2).astype(int)


CANDIDATES = {
    "Confluence>=2": strat_confluence,
    "Confluence=3": strat_confluence3,
    "Confluence tight RSI": strat_confluence_tight,
    "Confluence very tight RSI": strat_confluence_very_tight,
    "Confluence tight BB": strat_confluence_bb_tight,
    "Confluence 5-candle": strat_confluence_5candle,
    "RSI extreme": strat_rsi_extreme,
    "Bollinger revert": strat_bollinger,
    "3-candle revert": strat_3candle_revert,
    "5-candle revert": strat_5candle_revert,
}

# 1-minute expiry = 1 bar on 1m candles
EXPIRIES = [1, 2, 3, 5]
BLOCKS = [None, (0, 4), (4, 8), (8, 12), (12, 16), (16, 20), (20, 24)]


def score_1m(df, signals, bars, payout=0.90, blackout=None):
    """Score on 1m candles. signals: +1 CALL, -1 PUT, 0 none. bars = expiry in 1m candles."""
    blackout = blackout or []
    sig = pd.Series(signals, index=df.index).fillna(0).astype(int)
    wins = losses = 0
    for i in range(len(df) - bars):
        if sig.iloc[i] == 0:
            continue
        h = i // 60  # hour of day
        if any(a <= h < b for a, b in blackout):
            continue
        entry = float(df["close"].iloc[i])
        exit_ = float(df["close"].iloc[i + bars])
        if sig.iloc[i] == 1:
            if exit_ > entry: wins += 1
            else: losses += 1
        else:
            if exit_ < entry: wins += 1
            else: losses += 1
    t = wins + losses
    wr = wins / t * 100 if t else 0.0
    pnl = wins * payout * 10 - losses * 10
    return {"trades": t, "win_rate": wr, "pnl": pnl}


def evaluate(data, fn, bars, block):
    blackout = [] if block is None else ([(0, block[0])] if block[0] > 0 else []) + ([(block[1], 24)] if block[1] < 24 else [])
    w = t = 0; pnl = 0.0
    for s, d in data.items():
        r = score_1m(d, fn(d).fillna(0), bars, 0.90, blackout)
        t += r["trades"]; w += r["win_rate"] * r["trades"] / 100; pnl += r["pnl"]
    return t, (w / t * 100 if t else 0.0), pnl


def main():
    full = {s: load_1m(s) for s in SYMS_1M}
    split = full["EURUSD"].index[len(full["EURUSD"]) // 2]
    train = {s: d[d.index < split] for s, d in full.items()}
    test = {s: d[d.index >= split] for s, d in full.items()}
    print(f"1-MINUTE EXPIRY LAB")
    print(f"Train: {full['EURUSD'].index[0].date()} -> {split.date()}   Test: {split.date()} -> {full['EURUSD'].index[-1].date()}")
    print(f"Break-even: {BE}%   |   payout assumed 0.90\n")

    results = []
    for name, fn in CANDIDATES.items():
        for bars in EXPIRIES:
            for block in BLOCKS:
                t, wr, pnl = evaluate(train, fn, bars, block)
                if t >= 200 and wr > BE + 1.0:
                    results.append((name, bars, block, t, wr, pnl))
    results.sort(key=lambda r: -r[4])
    print(f"Rules that beat {BE + 1.0:.1f}% on TRAIN (>=200 trades): {len(results)}\n")
    print(f"{'strategy':<26}{'exp':<5}{'hours':<10}{'TRAIN n':>8}{'TRAIN%':>8}  |{'TEST n':>8}{'TEST%':>8}{'pnl/100':>10}  verdict")
    survivors = 0
    for name, bars, block, t, wr, pnl in results[:30]:
        tt, twr, tpnl = evaluate(test, CANDIDATES[name], bars, block)
        ok = tt >= 100 and twr > BE
        survivors += ok
        hb = "all" if block is None else f"{block[0]:02d}-{block[1]:02d}"
        print(f"{name:<26}{bars}m{'':<3}{hb:<10}{t:>8}{wr:>8.1f}  |{tt:>8}{twr:>8.1f}{(tpnl/tt*10 if tt else 0):>10.1f}  {'SURVIVES' if ok else 'fails'}")
    print(f"\nSurvivors on untouched TEST data: {survivors} of {min(30, len(results))}")


if __name__ == "__main__":
    main()
