"""Global configuration for the Pocket Option signal dashboard."""

import os
from dotenv import load_dotenv

load_dotenv()

# --- Assets to watch ---
# Use symbols that exist on both biquote/MetaTrader and Pocket Option.
# Pocket Option usually shows them as EUR/USD, GBP/USD, etc.
ASSETS = {
    "EURUSD": {"label": "EUR/USD", "payout": 0.92, "category": "forex"},
    "GBPUSD": {"label": "GBP/USD", "payout": 0.90, "category": "forex"},
    "USDJPY": {"label": "USD/JPY", "payout": 0.88, "category": "forex"},
    "AUDUSD": {"label": "AUD/USD", "payout": 0.87, "category": "forex"},
    "XAUUSD": {"label": "Gold", "payout": 0.88, "category": "commodity"},
    "BTCUSD": {"label": "BTC/USD", "payout": 0.95, "category": "crypto"},
}

DEFAULT_ASSET = "EURUSD"

# --- Signal timeframes ---
CHART_TIMEFRAME = "5m"      # candles used for S/R and trend
SIGNAL_TIMEFRAME = "1m"     # candles used for entry timing
SIGNAL_INTERVAL_SECONDS = 30  # how often the engine refreshes

# --- Risk / stake ---
DEFAULT_STAKE = 10.0
MAX_DAILY_LOSS = 100.0
MAX_CONSECUTIVE_LOSS = 3

# --- S/R engine parameters ---
SWING_LOOKBACK = 12         # candles to look back for swing points
SR_TOUCH_THRESHOLD_PCT = 0.0010   # price must be within 0.10% of a level (slightly looser)
EMA_FAST = 8
EMA_SLOW = 21
MIN_STRENGTH = 5            # 0-10 scale; signals below this are filtered (slightly looser)
SIGNAL_COOLDOWN_SECONDS = 90      # do not re-alert for same asset+direction within 90 sec

# --- Oscillator confirmation ---
RSI_PERIOD = 14
RSI_OVERBOUGHT = 70         # CALL signals are rejected if RSI >= this value
RSI_OVERSOLD = 30           # PUT signals are rejected if RSI <= this value
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIGNAL = 9

# --- Session filter (UTC hours) ---
# Forex major sessions. Set SESSION_FILTER = [] to disable.
SESSIONS_UTC = {
    "tokyo": (0, 9),
    "london": (8, 16),
    "ny": (13, 21),
    "london_ny_overlap": (13, 16),
}
SESSION_FILTER = []  # e.g. ["london", "ny"] to restrict signals to those sessions

# --- Telegram (optional) ---
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# --- Paths ---
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

TRADES_FILE = os.path.join(DATA_DIR, "trades.csv")
SIGNALS_FILE = os.path.join(DATA_DIR, "signals.jsonl")
