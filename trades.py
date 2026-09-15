"""Trade journal, outcome logging and performance analytics."""

import csv
import json
import logging
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional

import pandas as pd

import config

logger = logging.getLogger(__name__)


@dataclass
class Trade:
    signal_id: str
    asset: str
    direction: str
    entry_price: float
    stake: float
    expiry_minutes: int
    opened_at: str
    result: str = "open"          # open / win / loss / void
    exit_price: Optional[float] = None
    payout: float = 0.0
    closed_at: Optional[str] = None
    notes: str = ""

    def to_dict(self) -> Dict:
        return asdict(self)


class TradeJournal:
    def __init__(self):
        self.trades_file = config.TRADES_FILE
        self._ensure_file()

    def _ensure_file(self):
        if not os.path.exists(self.trades_file):
            with open(self.trades_file, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=[
                    "signal_id", "asset", "direction", "entry_price", "stake",
                    "expiry_minutes", "opened_at", "result", "exit_price",
                    "payout", "closed_at", "notes"
                ])
                writer.writeheader()

    def open_trade(self, signal_id: str, asset: str, direction: str,
                   entry_price: float, stake: float, expiry_minutes: int,
                   opened_at: Optional[str] = None) -> Trade:
        trade = Trade(
            signal_id=signal_id,
            asset=asset,
            direction=direction,
            entry_price=entry_price,
            stake=stake,
            expiry_minutes=expiry_minutes,
            opened_at=opened_at or datetime.now(timezone.utc).isoformat(),
        )
        self._append_row(trade.to_dict())
        return trade

    def close_trade(self, signal_id: str, result: str, payout: float = 0.0,
                    exit_price: Optional[float] = None, notes: str = ""):
        """Close a trade by signal_id. Only the most recent open trade for that signal is closed."""
        if not os.path.exists(self.trades_file):
            return

        rows = []
        target_found = False
        with open(self.trades_file, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if (row["signal_id"] == signal_id and row["result"] == "open"
                        and not target_found):
                    row["result"] = result
                    row["payout"] = str(payout)
                    row["exit_price"] = str(exit_price) if exit_price else ""
                    row["closed_at"] = datetime.now(timezone.utc).isoformat()
                    row["notes"] = notes
                    target_found = True
                rows.append(row)

        with open(self.trades_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=reader.fieldnames)
            writer.writeheader()
            writer.writerows(rows)

        if not target_found:
            logger.warning("No open trade found to close for signal_id=%s", signal_id)

    def _append_row(self, row: Dict):
        with open(self.trades_file, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=[
                "signal_id", "asset", "direction", "entry_price", "stake",
                "expiry_minutes", "opened_at", "result", "exit_price",
                "payout", "closed_at", "notes"
            ])
            writer.writerow(row)

    def get_trades(self) -> pd.DataFrame:
        if not os.path.exists(self.trades_file):
            return pd.DataFrame()
        df = pd.read_csv(self.trades_file)
        if df.empty:
            return df
        df["opened_at"] = pd.to_datetime(df["opened_at"], utc=True, errors="coerce")
        return df.sort_values("opened_at", ascending=False).reset_index(drop=True)

    @staticmethod
    def _max_consecutive_losses(results: list) -> int:
        max_streak = 0
        current = 0
        for r in results:
            if r == "loss":
                current += 1
                max_streak = max(max_streak, current)
            elif r == "win":
                current = 0
        return max_streak

    def analytics(self) -> Dict:
        df = self.get_trades()
        if df.empty:
            return {
                "total_trades": 0,
                "wins": 0,
                "losses": 0,
                "win_rate": 0.0,
                "profit": 0.0,
                "open_trades": 0,
                "max_consecutive_losses": 0,
                "assets": []
            }

        total = len(df)
        wins = int((df["result"] == "win").sum())
        losses = int((df["result"] == "loss").sum())
        open_trades = int((df["result"] == "open").sum())
        win_rate = (wins / (wins + losses) * 100) if (wins + losses) else 0.0

        # P/L calculation: stake returned on loss is 0; on win stake + payout
        df["pnl"] = df.apply(lambda r: float(r["payout"]) if r["result"] == "win" else -float(r["stake"]) if r["result"] == "loss" else 0.0, axis=1)
        profit = float(df["pnl"].sum())

        # Daily loss based on opened_at date in UTC
        today = datetime.now(timezone.utc).date()
        df["date"] = df["opened_at"].dt.date
        daily_loss = float(df[(df["date"] == today) & (df["pnl"] < 0)]["pnl"].sum())

        closed = df[df["result"].isin(["win", "loss"])].sort_values("opened_at").reset_index(drop=True)
        max_loss_streak = self._max_consecutive_losses(closed["result"].tolist()) if not closed.empty else 0

        halted_by_streak = max_loss_streak >= config.MAX_CONSECUTIVE_LOSS
        halted_by_daily = abs(daily_loss) >= config.MAX_DAILY_LOSS
        halted = halted_by_streak or halted_by_daily

        # Per-asset stats
        asset_stats = []
        for asset in sorted(df["asset"].unique()):
            adf = df[df["asset"] == asset]
            aw = int((adf["result"] == "win").sum())
            al = int((adf["result"] == "loss").sum())
            aprofit = adf.apply(
                lambda r: float(r["payout"]) if r["result"] == "win" else -float(r["stake"]) if r["result"] == "loss" else 0.0,
                axis=1
            ).sum()
            asset_stats.append({
                "asset": asset,
                "wins": aw,
                "losses": al,
                "profit": round(aprofit, 2),
                "win_rate": round(aw / (aw + al) * 100, 2) if (aw + al) else 0.0,
            })

        return {
            "total_trades": total,
            "wins": wins,
            "losses": losses,
            "win_rate": round(win_rate, 2),
            "profit": round(profit, 2),
            "open_trades": open_trades,
            "max_consecutive_losses": max_loss_streak,
            "daily_loss": round(daily_loss, 2),
            "trading_halted": halted,
            "halt_reason": "max_loss_streak" if halted_by_streak else ("daily_loss" if halted_by_daily else None),
            "assets": sorted(df["asset"].unique().tolist()),
            "asset_stats": asset_stats,
        }


class SignalLog:
    """Append-only log of all generated signals for later analysis."""

    def __init__(self):
        self.file = config.SIGNALS_FILE

    def append(self, signal: Dict):
        with open(self.file, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                **signal,
                "logged_at": datetime.now(timezone.utc).isoformat()
            }) + "\n")

    def recent(self, n: int = 50) -> List[Dict]:
        if not os.path.exists(self.file):
            return []
        with open(self.file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        recent_lines = lines[-n:] if len(lines) > n else lines
        return [json.loads(line) for line in recent_lines if line.strip()]
