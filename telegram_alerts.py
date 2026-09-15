"""Optional Telegram alert sender for signal notifications."""

import logging
from typing import Dict, Optional

import requests

import config

logger = logging.getLogger(__name__)


class TelegramAlerter:
    def __init__(self, token: Optional[str] = None, chat_id: Optional[str] = None):
        self.token = token or config.TELEGRAM_BOT_TOKEN
        self.chat_id = chat_id or config.TELEGRAM_CHAT_ID
        self.enabled = bool(self.token and self.chat_id)
        if not self.enabled:
            logger.info("Telegram alerts disabled (no token/chat_id).")

    def send_signal(self, signal: Dict) -> bool:
        if not self.enabled:
            return False

        message = self.format_signal(signal)
        return self._send(message)

    def send_message(self, message: str) -> bool:
        if not self.enabled:
            return False
        return self._send(message)

    def format_signal(self, signal: Dict) -> str:
        direction_emoji = "CALL" if signal["direction"] == "CALL" else "PUT"
        return (
            f"POCKET OPTION SIGNAL\n"
            f"Asset: {signal['label']} ({signal['asset']}) — real pair, NOT OTC\n"
            f"Direction: {direction_emoji}\n"
            f"Strength: {signal['strength']}/10\n"
            f"Current price: {signal['current_price']}\n"
            f"Expiry: {signal['expiry_minutes']} min\n"
            f"Suggested stake: ${signal['suggested_stake']}\n"
            f"Entry window: {signal['entry_window_start']} - {signal['entry_window_end']}\n"
            f"Reason: {signal['reason']}\n"
            f"Support: {signal.get('support', 'n/a')}\n"
            f"Resistance: {signal.get('resistance', 'n/a')}"
        )

    def _send(self, message: str) -> bool:
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": message,
        }
        try:
            response = requests.post(url, json=payload, timeout=15)
            response.raise_for_status()
            logger.info("Telegram alert sent.")
            return True
        except Exception as exc:
            logger.warning("Failed to send Telegram alert: %s", exc)
            if hasattr(exc, "response") and exc.response is not None:
                logger.warning("Telegram response: %s", exc.response.text)
            return False
