# AGENTS.md — Pocket Option Chart Assistant

Read this file first. It explains what this project is, how it's wired, and the
rules that must not be broken.

## What this project is

A **local** trading-assistance tool for manual Pocket Option **demo** trading.
It has two separate parts that share a Flask backend:

1. **Independent-feed dashboard** (`templates/index.html`) — the original tool.
   Scans real (non-OTC) forex pairs using `biquote` live quotes and Dukascopy
   history, generates signals, simulates trades, logs outcomes, sends Telegram
   alerts. This subsystem is unchanged by the extension work.

2. **Visual chart assistant** — reads the user's own Pocket Option chart via
   browser tab capture and asks OpenAI vision for BUY / SELL / WAIT.
   Delivered two ways sharing the same code:
   - Standalone page: `http://127.0.0.1:5000/screen-analysis`
   - **Chrome/Edge MV3 side-panel extension** (the primary interface), loaded
     unpacked from `extension_dist/` (generated, gitignored — rebuild with
     `build_extension.py`).

## Hard rules — do not violate

- **Manual execution only.** Never automate Pocket Option login, order buttons,
  cookies, credentials, or any broker API. The app only watches a chart image.
- **The OpenAI key lives in `.env` on the backend only.** Never put it in
  extension files, browser storage, URLs, git, or chat output. `.env` is
  gitignored; `extension_dist` is gitignored.
- **Extension talks to localhost only** (`http://127.0.0.1/*`). No remote
  scripts, no other hosts.
- **Preview consent before upload.** The user must see the crop and approve it
  before any image is sent. Changing the crop clears consent.
- **Manual scan protocol v2.** There is NO continuous/idle scanning. One SCAN
  click → two fresh frames (~0.7–2.5s apart) → ONE paid request. Backend
  rejects any other mode (`scan_mode: 'manual'`, `scan_protocol: 2`).
- **Never claim win rates or profitability.** The strategies are experimental.
  The on-screen percentage is "rule match" (checklist progress), never a win
  probability. Entry timing is only shown when a real candle clock is readable.
- Prefer **WAIT over guessing**. Technical errors must be shown distinctly from
  a valid "no setup" WAIT.
- Don't use OTC data as if synced with independent feeds. OTC prices are
  broker-internal.

## Architecture map

| File | Role |
|---|---|
| `app.py` | Flask app: dashboard routes, vision routes, extension pairing/journal routes |
| `cloud_vision.py` | OpenAI vision service: schema, prompts, `validate_payload`, `validate_result`, Aroon/OsMA rule checks, rate limits (10s min between calls, 60/hour) |
| `extension_access.py` | Extension approval/challenge handoff, persistent revocable authorization |
| `vision_journal.py` | SQLite journal: analyses, displayed cues, manual entries/outcomes, payout-aware P/L |
| `static/screen_capture.js` | Shared capture+scan controller used by BOTH the page and the extension. Manual scan state machine lives here. |
| `static/screen_analysis.js` | Pure helpers: crop math, `chartDomCrop`, `CandleClock`, `headerChanged`, `localIdentity`, `identityMatches`, `entryTiming`, `freshCloudResult` |
| `static/chart_alerts.js` | `TonePlayer` (BUY rising / SELL falling tones) + `AlertGate` (duplicate-suppression/re-arm logic) |
| `extension/manifest.json` | MV3 manifest. Permissions: activeTab, tabCapture, sidePanel, storage, scripting, notifications. Host: localhost only |
| `extension/worker.js` | Service worker: icon-click → select Pocket Option tab, tab capture stream, notifications |
| `extension/bridge.js` | Panel↔worker bridge, localhost API transport with session token, layout probe relay, alert prefs |
| `extension/chart_probe.js` | Read-only DOM probe injected into the selected tab: chart bounds, indicator labels, unique pair/timeframe identity, candle clock. Returns geometry only — no cookies/text mining |
| `extension/panel.{html,css,js}` | Compact side-panel UI: big BUY/SELL/WAIT, rule-match %, bias, entry timing, one SCAN action, drawers for details/settings/journal |
| `build_extension.py` | Copies `extension/` + shared `static/` + `chart_alerts.js` into `extension_dist/` |
| `templates/extension_pair.html` | Local approval page (challenge handoff, no key copying) |
| `signal_engine.py`, `simulator.py`, `trades.py`, `telegram_alerts.py`, `config.py` | Independent-feed subsystem (untouched by extension work) |

## Strategy settings (visual assistant)

- Default strategy `aroon_osma`: Aroon period 10 (Up turquoise / Down red) +
  OsMA 10/20/10 on **30-second candles**, intended **2-minute** manual expiry.
- BUY = Up crosses above Down between last two **completed** candles with ≥20pt
  gap AND OsMA > 0 and rising. SELL = mirror. Everything else → WAIT.
- Second strategy `trend_range` (1m candles) kept available.
- Model: `gpt-4.1-mini-2025-04-14`, structured JSON output, `store: false`.
- Server re-validates every model response against extracted numeric evidence;
  conflicts are forced to WAIT or rejected as technical errors.

## How to run

```powershell
.\start_server.ps1        # idempotent; serves on http://127.0.0.1:5000
```

Requires `.env` with `OPENAI_API_KEY` (never commit it). Then load the
extension: `edge://extensions` → Developer mode → Load unpacked →
`extension_dist/`. Click its icon on the Pocket Option demo tab → approve
connection once → preview → **SCAN**.

## How to test

```powershell
# Python (49 tests)
./venv/Scripts/python.exe -m unittest test_vision_journal test_cloud_vision test_screen_routes test_extension

# JavaScript (97 tests, Node's built-in runner — no npm install needed)
node --test test_chart_alerts.cjs test_extension_alerts.cjs test_cloud_capture.cjs test_screen_analysis.cjs test_chart_probe.cjs test_extension.cjs test_extension_panel.cjs

# Rebuild extension after changing extension/ or static/
./venv/Scripts/python.exe build_extension.py
```

Tests mock fetch/media — **no real API calls, no images sent**. Keep it that
way: never add a test that calls OpenAI or uploads a real chart.

## Current state / known limits

- Screenshot interpretation is an **estimate**, not a candle feed — values can
  be misread; strict validation and freshness checks mitigate but don't prove
  edge. Strategy is under demo evaluation; collect journal outcomes before
  changing it.
- Candle-aware entry timing only appears if the DOM exposes an explicitly
  labelled candle timestamp (usually it doesn't → honest "unreadable" status).
- `extension_dist` is a build artifact — always rebuild before telling the user
  to reload the extension in Edge.
- Backend runs detached via `pythonw` (`start_server.ps1`); logs in `logs/`.
