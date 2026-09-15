"""Global configuration for the Pocket Option signal dashboard."""

import os
from dotenv import load_dotenv

load_dotenv()

# --- Assets to watch ---
# Use symbols that exist on both biquote/MetaTrader and Pocket Option.
# Pocket Option usually shows them as EUR/USD, GBP/USD, etc.
# 4 majors + 7 cross pairs that passed the 3-month out-of-sample test
# (>54% win rate, >=150 trades on unseen Aug-Sep data with the confluence strategy).
ASSETS = {
    "EURUSD": {"label": "EUR/USD", "payout": 0.92, "category": "forex"},
    "GBPUSD": {"label": "GBP/USD", "payout": 0.90, "category": "forex"},
    "AUDUSD": {"label": "AUD/USD", "payout": 0.87, "category": "forex"},
    "USDJPY": {"label": "USD/JPY", "payout": 0.88, "category": "forex"},
    "EURAUD": {"label": "EUR/AUD", "payout": 0.85, "category": "forex"},
    "CADJPY": {"label": "CAD/JPY", "payout": 0.85, "category": "forex"},
    "NZDJPY": {"label": "NZD/JPY", "payout": 0.85, "category": "forex"},
    "GBPAUD": {"label": "GBP/AUD", "payout": 0.85, "category": "forex"},
    "EURJPY": {"label": "EUR/JPY", "payout": 0.85, "category": "forex"},
    "GBPJPY": {"label": "GBP/JPY", "payout": 0.85, "category": "forex"},
    "CHFJPY": {"label": "CHF/JPY", "payout": 0.85, "category": "forex"},
}

DEFAULT_ASSET = "EURUSD"

# --- Signal timeframes ---
CHART_TIMEFRAME = "5m"      # candles the strategy is evaluated on (closed candles only)
SIGNAL_TIMEFRAME = "1m"     # candles used for entry timing
SIGNAL_INTERVAL_SECONDS = 30  # how often the engine refreshes
EXPIRY_MINUTES = 30         # Pocket Option expiry to use for every signal
ENTRY_WINDOW_SECONDS = 120  # enter within this long after the signal candle closes

# --- Strategy: mean-reversion confluence (see strategy_lab2.py) ---
# Votes: RSI extreme, close outside Bollinger 20/2, three same-colour candles.
#   Rule A: all 3 votes -> trade at any hour        (Aug-Sep unseen: ~57-61% on majors)
#   Rule B: 2 of 3 votes, only 20:00-24:00 UTC      (Aug-Sep unseen: ~62%)
BB_PERIOD = 20
BB_STD = 2.0
CONFLUENCE_LATE_HOURS_UTC = [(20, 24)]
CONFLUENCE_LATE_MIN_VOTES = 2

# --- Risk / stake ---
DEFAULT_STAKE = 10.0
MAX_DAILY_LOSS = 100.0
MAX_CONSECUTIVE_LOSS = 3

# --- S/R levels (still drawn on the chart; no longer drive signals) ---
SWING_LOOKBACK = 12         # candles to look back for swing points
SR_TOUCH_THRESHOLD_PCT = 0.0010
EMA_FAST = 8
EMA_SLOW = 21
MIN_STRENGTH = 7            # 0-10 scale; confluence signals score 7-10
SIGNAL_COOLDOWN_SECONDS = 300     # one alert per asset+direction per 5m candle

# --- Oscillators ---
RSI_PERIOD = 14
RSI_OVERBOUGHT = 70         # PUT vote when RSI > this
RSI_OVERSOLD = 30           # CALL vote when RSI < this
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

# Hours (UTC, start inclusive, end exclusive) where no signals are produced.
# Empty for the confluence strategy: its best block is 20:00-24:00 UTC.
BLACKOUT_HOURS_UTC = []

# --- Auto-simulation ---
# When True, every generated signal is automatically opened as a simulated
# trade (one open sim trade per asset) and resolved after expiry.
AUTO_SIMULATE = True

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
