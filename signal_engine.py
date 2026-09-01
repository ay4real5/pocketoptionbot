"""Market data fetcher and signal generator for Pocket Option."""

import json
import logging
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional

import biquote
import numpy as np
import pandas as pd

import config

logger = logging.getLogger(__name__)


@dataclass
class Signal:
    asset: str
    label: str
    direction: str              # CALL or PUT
    strength: int               # 0-10
    current_price: float
    support: Optional[float]
    resistance: Optional[float]
    expiry_minutes: int
    suggested_stake: float
    reason: str
    generated_at: str
    entry_window_start: str
    entry_window_end: str

    def to_dict(self) -> Dict:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


class SignalEngine:
    def __init__(self):
        self.bq = biquote.Biquote()
        self.last_signal: Optional[Signal] = None

    def fetch_ohlc(self, symbol: str, interval: str, limit: int = 100) -> pd.DataFrame:
        """Fetch OHLC from biquote and normalize into a pandas DataFrame."""
        try:
            raw = self.bq.ohlc(symbol, interval=interval, limit=limit)
        except Exception as exc:
            logger.warning("Failed to fetch OHLC for %s (%s): %s", symbol, interval, exc)
            return pd.DataFrame()

        if not raw:
            return pd.DataFrame()

        df = pd.DataFrame(raw)
        df["openTime"] = pd.to_datetime(df["openTime"], utc=True)
        df = df.rename(columns={
            "openTime": "time",
            "open": "open",
            "high": "high",
            "low": "low",
            "close": "close",
            "volume": "volume",
            "tickVolume": "tick_volume",
        })
        df = df.sort_values("time").reset_index(drop=True)
        return df

    @staticmethod
    def compute_ema(series: pd.Series, period: int) -> pd.Series:
        return series.ewm(span=period, adjust=False).mean()

    @staticmethod
    def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
        delta = series.diff()
        gain = delta.where(delta > 0, 0.0)
        loss = (-delta).where(delta < 0, 0.0)
        avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
        rs = avg_gain / avg_loss.replace(0, 1e-12)
        rsi = 100 - (100 / (1 + rs))
        return rsi

    @staticmethod
    def compute_macd(series: pd.Series, fast: int, slow: int, signal: int) -> tuple:
        ema_fast = series.ewm(span=fast, adjust=False).mean()
        ema_slow = series.ewm(span=slow, adjust=False).mean()
        macd_line = ema_fast - ema_slow
        signal_line = macd_line.ewm(span=signal, adjust=False).mean()
        histogram = macd_line - signal_line
        return macd_line, signal_line, histogram

    @staticmethod
    def find_swing_levels(df: pd.DataFrame, lookback: int) -> List[float]:
        """Return recent swing high/low prices that may act as S/R."""
        if len(df) < lookback + 2:
            return []

        levels = set()
        for i in range(lookback, len(df) - lookback):
            window_before = df.iloc[i - lookback:i]
            window_after = df.iloc[i + 1:i + lookback + 1]
            candle = df.iloc[i]

            if candle["high"] >= window_before["high"].max() and candle["high"] >= window_after["high"].max():
                levels.add(round(candle["high"], 6))
            if candle["low"] <= window_before["low"].min() and candle["low"] <= window_after["low"].min():
                levels.add(round(candle["low"], 6))

        return sorted(levels)

    def nearest_level(self, price: float, levels: List[float], direction: str) -> Optional[float]:
        """Find nearest support or resistance level."""
        if not levels:
            return None
        if direction == "support":
            candidates = [l for l in levels if l <= price]
            return max(candidates) if candidates else None
        else:
            candidates = [l for l in levels if l >= price]
            return min(candidates) if candidates else None

    def distance_pct(self, price: float, level: float) -> float:
        """Return distance between price and a level as a percentage of price."""
        if price == 0:
            return float("inf")
        return abs(price - level) / price

    @staticmethod
    def in_session() -> bool:
        """Check if current UTC hour is within configured trading sessions."""
        if not config.SESSION_FILTER:
            return True
        hour = datetime.now(timezone.utc).hour
        for name in config.SESSION_FILTER:
            start, end = config.SESSIONS_UTC[name]
            if start <= hour < end:
                return True
        return False

    def generate_signal(self, symbol: str) -> Optional[Signal]:
        """Generate a trading signal for a single asset."""
        asset_meta = config.ASSETS.get(symbol)
        if not asset_meta:
            logger.warning("Unknown symbol: %s", symbol)
            return None

        df = self.fetch_ohlc(symbol, config.CHART_TIMEFRAME, limit=100)
        if df.empty or len(df) < config.EMA_SLOW + 5:
            logger.warning("Not enough data for %s", symbol)
            return None

        if not self.in_session():
            logger.debug("Outside configured trading sessions for %s", symbol)
            return None

        current_price = float(df["close"].iloc[-1])
        ema_fast = self.compute_ema(df["close"], config.EMA_FAST)
        ema_slow = self.compute_ema(df["close"], config.EMA_SLOW)

        trend = "UP" if ema_fast.iloc[-1] > ema_slow.iloc[-1] else "DOWN"
        trend_strength = abs(ema_fast.iloc[-1] - ema_slow.iloc[-1]) / current_price

        rsi = self.compute_rsi(df["close"], config.RSI_PERIOD)
        last_rsi = float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0

        macd_line, macd_signal, macd_hist = self.compute_macd(
            df["close"], config.MACD_FAST, config.MACD_SLOW, config.MACD_SIGNAL
        )
        last_hist = float(macd_hist.iloc[-1]) if not pd.isna(macd_hist.iloc[-1]) else 0.0

        levels = self.find_swing_levels(df, config.SWING_LOOKBACK)
        support = self.nearest_level(current_price, levels, "support")
        resistance = self.nearest_level(current_price, levels, "resistance")

        signal_direction = None
        score = 0
        reason_parts = []

        threshold = config.SR_TOUCH_THRESHOLD_PCT

        # CALL logic: price near support, trend up, RSI not overbought, MACD bullish
        if support is not None:
            dist = self.distance_pct(current_price, support)
            if dist <= threshold and trend == "UP":
                signal_direction = "CALL"
                # Closer to level = higher score
                score += int(max(0, 10 - (dist / threshold) * 3))
                reason_parts.append(f"price near support ({support:.5f})")
                reason_parts.append("uptrend via EMA")

                # RSI filter
                if last_rsi >= config.RSI_OVERBOUGHT:
                    signal_direction = None
                    reason_parts.append("rejected: RSI overbought")
                elif last_rsi <= config.RSI_OVERSOLD:
                    reason_parts.append("RSI oversold")

                # MACD filter
                if last_hist > 0:
                    score += 1
                    reason_parts.append("MACD bullish")
                elif last_hist < 0:
                    score = max(score - 1, 0)
                    reason_parts.append("MACD bearish")

        # PUT logic: price near resistance, trend down, RSI not oversold, MACD bearish
        if signal_direction is None and resistance is not None:
            dist = self.distance_pct(current_price, resistance)
            if dist <= threshold and trend == "DOWN":
                signal_direction = "PUT"
                score += int(max(0, 10 - (dist / threshold) * 3))
                reason_parts.append(f"price near resistance ({resistance:.5f})")
                reason_parts.append("downtrend via EMA")

                # RSI filter
                if last_rsi <= config.RSI_OVERSOLD:
                    signal_direction = None
                    reason_parts.append("rejected: RSI oversold")
                elif last_rsi >= config.RSI_OVERBOUGHT:
                    reason_parts.append("RSI overbought")

                # MACD filter
                if last_hist < 0:
                    score += 1
                    reason_parts.append("MACD bearish")
                elif last_hist > 0:
                    score = max(score - 1, 0)
                    reason_parts.append("MACD bullish")

        # Trend confluence boost
        if signal_direction:
            if trend_strength > 0.0002:
                score += 1
            score = min(score, 10)

        if not signal_direction or score < config.MIN_STRENGTH:
            return None

        now = datetime.now(timezone.utc)
        window_end = now + timedelta(seconds=45)

        signal = Signal(
            asset=symbol,
            label=asset_meta["label"],
            direction=signal_direction,
            strength=score,
            current_price=round(current_price, 6),
            support=round(support, 6) if support else None,
            resistance=round(resistance, 6) if resistance else None,
            expiry_minutes=int(config.CHART_TIMEFRAME.replace("m", "").replace("h", "00")),
            suggested_stake=config.DEFAULT_STAKE,
            reason="; ".join(reason_parts),
            generated_at=now.isoformat(),
            entry_window_start=now.isoformat(),
            entry_window_end=window_end.isoformat(),
        )

        self.last_signal = signal
        return signal

    def scan_all(self) -> List[Signal]:
        """Scan every configured asset and return active signals."""
        signals = []
        for symbol in config.ASSETS:
            try:
                sig = self.generate_signal(symbol)
                if sig:
                    signals.append(sig)
            except Exception as exc:
                logger.exception("Error scanning %s: %s", symbol, exc)
        return signals


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    engine = SignalEngine()
    sig = engine.generate_signal(config.DEFAULT_ASSET)
    if sig:
        print(sig.to_json())
    else:
        print("No signal generated")
