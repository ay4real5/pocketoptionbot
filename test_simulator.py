"""Unit test for the fake trade simulator."""

import os
import tempfile
from datetime import datetime, timezone, timedelta

from simulator import Simulator


def test_simulator_resolve():
    fd, path = tempfile.mkstemp(suffix=".csv", prefix="sim_trades_test_")
    os.close(fd)
    os.remove(path)  # let Simulator create it with its header

    sim = Simulator(path=path)

    signal = {
        "signal_id": "simtest1",
        "asset": "EURUSD",
        "direction": "CALL",
        "current_price": 1.1000,
        "suggested_stake": 10.0,
        "expiry_minutes": 1,
    }
    trade = sim.open_trade(signal)
    assert trade.result == "open"

    # Backdate the opened_at so it is already expired
    import pandas as pd
    df = pd.read_csv(path)
    df.loc[0, "opened_at"] = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
    df.to_csv(path, index=False)

    sim.resolve_open_trades()
    analytics = sim.analytics()
    print("Simulator analytics after resolve:", analytics)
    assert analytics["total"] == 1
    assert analytics["total"] == analytics["wins"] + analytics["losses"]

    # Clean up
    os.remove(path)
    print("Simulator test passed.")


if __name__ == "__main__":
    test_simulator_resolve()
