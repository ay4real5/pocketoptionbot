# Pocket Option Signal Assistant

A local, non-official signal dashboard for Pocket Option. It does **not** connect to Pocket Option's servers or place automatic trades. It reads public market data, generates support/resistance-based signals, shows them in a browser dashboard, and lets you log manual trades for performance tracking.

## Why this exists

Pocket Option does not publish a verified public trading API comparable to Deriv. Reverse-engineered libraries that log in with your browser session exist, but using them for real money risks account closure and withdrawal problems. This tool keeps execution in your hands while automating analysis and record-keeping.

## What it does

- Fetches real-time prices for 5 assets — EUR/USD, GBP/USD, AUD/USD, Gold, BTC/USD — from the free **biquote** MT5 feed (USD/JPY removed: lost money in both 24h backtests).
- Computes swing-based support / resistance levels and EMA trend.
- Adds RSI and MACD confirmation filters to reduce bad signals.
- Generates CALL/PUT signals with strength score, expiry window and suggested stake.
- Throttles repeated alerts so you do not get spammed.
- Shows live signals and an interactive price chart on a local web dashboard (`http://127.0.0.1:5000`).
- Plays a browser sound + notification + voice alert when a new signal appears.
- Lets you click "I took this trade" and later mark WIN / LOSS / VOID.
- Tracks win rate, profit/loss, per-asset stats, max loss streak, daily loss and open trades.
- **Auto-halts** new signals when max loss streak or daily loss limit is reached.
- Includes a **fake trade simulator** to test the strategy without risking funds — with `AUTO_SIMULATE` on, every signal is auto-simulated and resolved after expiry (one open sim trade per asset).
- Replays the last 24h of feed history in the dashboard's **Backtest** card: overall/per-asset/per-strength win rates vs a payout-adjusted break-even line.
- Exports trade history to CSV.
- One-click copy of trade details for fast manual entry on Pocket Option.
- Keyboard hotkeys: `C` confirm trade, `P` dismiss, `W` win, `L` loss, `S` simulate.
- Optional London / NY session filter with dashboard toggle.
- Optionally sends signal alerts to Telegram.

## Files

| File | Purpose |
|------|---------|
| `app.py` | Flask dashboard server and background scanner |
| `signal_engine.py` | Data fetching, S/R, EMA, RSI, MACD signal logic |
| `trades.py` | Trade journal CSV + analytics |
| `simulator.py` | Fake trade simulator for safe testing |
| `backtest.py` | Same-day replay of the strategy over feed history |
| `analyze_backtest.py` | Diagnostic breakdown of backtest results |
| `telegram_alerts.py` | Optional Telegram bot sender |
| `config.py` | Assets, timeframes, risk parameters, session filters |
| `templates/index.html` | Dashboard UI with chart and notifications |
| `run.ps1` | Start the dashboard on Windows (delegates to `start_server.ps1`) |
| `start_server.ps1` | Launches the server detached (survives terminal close); idempotent — no-op if port 5000 is already listening |
| `stop_server.ps1` | Kills the process listening on port 5000 |
| `setup.ps1` | One-time environment setup |

## Quick start

1. Open PowerShell in this folder.
2. Run setup once:
   ```powershell
   .\setup.ps1
   ```
3. Start the dashboard:
   ```powershell
   .\run.ps1
   ```
   The server runs detached (output in `logs\server.log`) and survives terminal closure. Use `.\stop_server.ps1` to stop it. A `pocketoption-dashboard.cmd` in the Windows Startup folder re-launches it on logon.
4. Open your browser to `http://127.0.0.1:5000`.
5. Keep Pocket Option open in another window. When a signal appears, decide whether to take it manually on Pocket Option, then click the matching button on the dashboard.

## Optional Telegram alerts

1. Create a Telegram bot with [@BotFather](https://t.me/botfather) and copy the token.
2. Get your chat ID (for example by messaging [@userinfobot](https://t.me/userinfobot)).
3. Create a `.env` file in this folder:
   ```
   TELEGRAM_BOT_TOKEN=your_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```
4. Restart the dashboard.

## Strategy logic

Signals are generated when:
- Price is within the configured percentage threshold of a recent swing support/resistance level.
- The short EMA is above/below the long EMA in the expected direction.
- RSI is not overbought for CALLs or oversold for PUTs.
- MACD histogram confirms the direction.
- A strength score (0-10) reaches the minimum threshold. Strength is: base 6, +1 strong EMA separation, +1 last candle moving with the trade, +1 asset in `PROVEN_ASSETS` (positive backtest record). Distance-to-level and MACD no longer affect the score.

Other `config.py` knobs:

- `BLACKOUT_HOURS_UTC = [(20, 24)]` — no signals 20:00-24:00 UTC (NY close/rollover was the weakest window in backtest).
- `PROVEN_ASSETS` — assets profitable in both 24h backtests so far; adds +1 strength.
- `AUTO_SIMULATE` — auto-open and auto-resolve a sim trade for every signal.

Optional London / NY session filter is in `config.py`. Set `SESSION_FILTER = []` to disable it.

Default parameters are in `config.py`. Edit them to match your own rules.

## Risk rules

- Use only the Pocket Option **demo account** until you have a proven edge.
- First test with the **fake trade simulator** inside the dashboard — no real or demo money at risk.
- Trade one asset at a time.
- Use fixed stakes, not a recovery ladder.
- Set a daily loss limit and stop.

## Disclaimer

This is an educational/assistive tool. It is not financial advice. Binary options carry high risk of loss. Never trade with money you cannot afford to lose. The authors are not affiliated with Pocket Option.
