"""Standalone smoke test for the signal engine."""

import json
import logging

import config
from signal_engine import SignalEngine

logging.basicConfig(level=logging.INFO)


def main():
    engine = SignalEngine()
    print("Fetching data and generating signals for watched assets...\n")

    found = False
    for symbol in config.ASSETS:
        sig = engine.generate_signal(symbol)
        if sig:
            found = True
            print("=" * 50)
            print(f"SYMBOL: {symbol} ({config.ASSETS[symbol]['label']})")
            print(json.dumps(sig.to_dict(), indent=2))
            print()
        else:
            print(f"{symbol}: no signal")

    if not found:
        print("No signals generated right now. Wait for a mean-reversion confluence (RSI extreme, Bollinger overshoot, 3 same-colour candles).")


if __name__ == "__main__":
    main()
