import html
import logging
from dataclasses import dataclass
from uuid import UUID

import httpx
from psycopg import Connection

# Telegram authenticates in the request URL. httpx logs full URLs at INFO, so
# suppress request logging before any bot call can expose a token.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


@dataclass(frozen=True)
class TelegramBot:
    token: str

    def _call(self, method: str, payload: dict) -> dict:
        response = httpx.post(
            f"https://api.telegram.org/bot{self.token}/{method}", json=payload, timeout=20.0,
        )
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(f"Telegram {method} failed: {result.get('description', 'unknown error')}")
        return result

    def set_webhook(self, url: str, secret: str) -> None:
        self._call("setWebhook", {"url": url, "secret_token": secret, "allowed_updates": ["message", "callback_query"]})

    def send_text(self, chat_id: str | int, text: str) -> None:
        self._call("sendMessage", {"chat_id": chat_id, "text": text})

    def answer_callback(self, callback_query_id: str, text: str) -> None:
        self._call("answerCallbackQuery", {"callback_query_id": callback_query_id, "text": text})

    def send_recommendation(self, conn: Connection, recommendation_id: UUID, chat_id: str | int, public_app_url: str) -> None:
        row = conn.execute(
            """
            SELECT r.id, r.rationale, v.title, v.speaker, v.channel_name
            FROM recommendations r JOIN videos v ON v.id = r.video_id
            WHERE r.id = %s
            """,
            (recommendation_id,),
        ).fetchone()
        if not row:
            raise ValueError("Recommendation not found")
        speaker = f"\n{html.escape(row['speaker'])}" if row["speaker"] else ""
        text = (
            f"<b>{html.escape(row['title'])}</b>{speaker}\n"
            f"{html.escape(row['channel_name'])}\n\n{html.escape(row['rationale'])}"
        )
        watch_url = f"{public_app_url.rstrip('/')}/r/{row['id']}"
        self._call("sendMessage", {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "reply_markup": {"inline_keyboard": [
                [{"text": "Watch on YouTube", "url": watch_url}],
                [
                    {"text": "👍 More like this", "callback_data": f"feedback:up:{row['id']}"},
                    {"text": "👎 Less like this", "callback_data": f"feedback:down:{row['id']}"},
                ],
            ]},
        })
