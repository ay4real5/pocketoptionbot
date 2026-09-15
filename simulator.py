"""Fake trade simulator - tests signals without risking real/demo funds.

It records hypothetical trades into a separate CSV. A CALL is treated as a win
if price at expiry is strictly above entry price; a PUT wins if strictly below;
an exact tie counts as a loss (matches backtest.py).
"""

import csv
import logging
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional

import pandas as pd

import config
from signal_engine import SignalEngine

logger = logging.getLogger(__name__)

SIM_TRADES_FILE = os.path.join(config.DATA_DIR, "sim_trades.csv")


@dataclass
class SimTrade:
    signal_id: str
    asset: str
    direction: str
    entry_price: float
    stake: float
    expiry_minutes: int
    opened_at: str
    exit_price: Optional[float] = None
    result: str = "open"
    payout: float = 0.0
    closed_at: Optional[str] = None

    def to_dict(self) -> Dict:
        return asdict(self)


class Simulator:
    """Records hypothetical trades and resolves them after expiry."""

    def __init__(self, engine=None, path: Optional[str] = None):
        self.engine = engine or SignalEngine()
        self.path = path or SIM_TRADES_FILE
        self._ensure_file()

    def _ensure_file(self):
        if not os.path.exists(self.path):
            with open(self.path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=[
                    "signal_id", "asset", "direction", "entry_price", "stake",
                    "expiry_minutes", "opened_at", "exit_price",
                    "result", "payout", "closed_at"
                ])
                writer.writeheader()

    def open_trade(self, signal: Dict, payout_rate: float = 0.90) -> SimTrade:
        now = datetime.now(timezone.utc)
        stake = float(signal.get("suggested_stake", config.DEFAULT_STAKE))
        trade = SimTrade(
            signal_id=signal.get("signal_id", ""),
            asset=signal.get("asset", ""),
            direction=signal.get("direction", ""),
            entry_price=float(signal.get("current_price", 0)),
            stake=stake,
            expiry_minutes=int(signal.get("expiry_minutes", config.EXPIRY_MINUTES)),
            opened_at=now.isoformat(),
        )
        self._append(trade.to_dict())
        return trade

    def resolve_open_trades(self):
        """Check current prices and close any trades whose expiry has passed."""
        if not os.path.exists(self.path):
            return

        df = pd.read_csv(self.path)
        if df.empty:
            return

        now = datetime.now(timezone.utc)
        updated_rows = []
        for _, row in df.iterrows():
            if row["result"] != "open":
                updated_rows.append(row.to_dict())
                continue
            opened = pd.to_datetime(row["opened_at"], utc=True)
            expiry = opened + timedelta(minutes=int(row["expiry_minutes"]))
            if now < expiry:
                updated_rows.append(row.to_dict())
                continue

            # Resolve trade
            try:
                tick = self.engine.bq.tick(row["asset"])
                exit_price = float(tick["mid"])
            except Exception as exc:
                logger.warning("Could not resolve sim trade %s: %s", row["signal_id"], exc)
                updated_rows.append(row.to_dict())
                continue

            direction = row["direction"]
            entry = float(row["entry_price"])
            # Strict: an exact tie counts as a loss (matches backtest.py)
            if direction == "CALL":
                result = "win" if exit_price > entry else "loss"
            else:
                result = "win" if exit_price < entry else "loss"

            payout = 0.0
            if result == "win":
                payout = float(row.get("stake", config.DEFAULT_STAKE)) * 0.90

            new_row = row.to_dict()
            new_row["exit_price"] = exit_price
            new_row["result"] = result
            new_row["payout"] = payout
            new_row["closed_at"] = now.isoformat()
            updated_rows.append(new_row)

        with open(self.path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=updated_rows[0].keys())
            writer.writeheader()
            writer.writerows(updated_rows)

    def has_open_trade(self, asset: str) -> bool:
        """True if there is an unresolved sim trade for this asset."""
        if not os.path.exists(self.path):
            return False
        df = pd.read_csv(self.path)
        if df.empty:
            return False
        return bool(((df["asset"] == asset) & (df["result"] == "open")).any())

    def analytics(self) -> Dict:
        empty = {"total": 0, "wins": 0, "losses": 0, "open": 0, "win_rate": 0.0, "profit": 0.0}
        if not os.path.exists(self.path):
            return empty
        df = pd.read_csv(self.path)
        if df.empty:
            return empty
        wins = int((df["result"] == "win").sum())
        losses = int((df["result"] == "loss").sum())
        open_count = int((df["result"] == "open").sum())
        total = wins + losses
        win_rate = (wins / total * 100) if total else 0.0
        profit = df.apply(
            lambda r: float(r["payout"]) if r["result"] == "win" else -float(r.get("stake", config.DEFAULT_STAKE)) if r["result"] == "loss" else 0.0,
            axis=1
        ).sum()
        return {
            "total": int(total),
            "wins": int(wins),
            "losses": int(losses),
            "open": open_count,
            "win_rate": round(float(win_rate), 2),
            "profit": round(float(profit), 2),
        }

    def _append(self, row: Dict):
        self._ensure_file()
        with open(self.path, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=[
                "signal_id", "asset", "direction", "entry_price", "stake",
                "expiry_minutes", "opened_at", "exit_price",
                "result", "payout", "closed_at"
            ])
            writer.writerow(row)
