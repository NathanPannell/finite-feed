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


def _truncate_utf16(value: str, maximum_units: int) -> str:
    encoded = value.encode("utf-16-le")
    if len(encoded) <= maximum_units * 2:
        return value
    return encoded[: (maximum_units - 1) * 2].decode("utf-16-le", errors="ignore").rstrip() + "…"


@dataclass(frozen=True)
class TelegramBot:
    token: str

    def _call(self, method: str, payload: dict) -> dict:
        try:
            response = httpx.post(
                f"https://api.telegram.org/bot{self.token}/{method}", json=payload, timeout=20.0,
            )
        except httpx.HTTPError:
            raise RuntimeError("Telegram request failed; retry after cooldown") from None
        if response.is_error:
            raise RuntimeError(f"Telegram request failed (HTTP {response.status_code})")
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(f"Telegram {method} failed: {result.get('description', 'unknown error')}")
        return result

    def set_webhook(self, url: str, secret: str) -> None:
        self._call("setWebhook", {"url": url, "secret_token": secret, "allowed_updates": ["message", "callback_query"]})

    def send_text(self, chat_id: str | int, text: str) -> None:
        self._call("sendMessage", {"chat_id": chat_id, "text": text})

    def send_preference_confirmation(
        self, chat_id: str | int, confirmation_id: UUID, proposed_text: str,
    ) -> None:
        prefix = "Adding '"
        suffix = "' to preferences, is that okay?"
        available = 4096 - len((prefix + suffix).encode("utf-16-le")) // 2
        prompt = prefix + _truncate_utf16(proposed_text, available) + suffix
        self._call("sendMessage", {
            "chat_id": chat_id,
            "text": _truncate_utf16(prompt, 4096),
            "reply_markup": {"inline_keyboard": [[
                {"text": "Yes, update", "callback_data": f"preference:yes:{confirmation_id}"},
                {"text": "No, don't update", "callback_data": f"preference:no:{confirmation_id}"},
            ]]},
        })

    def answer_callback(self, callback_query_id: str, text: str) -> None:
        self._call("answerCallbackQuery", {"callback_query_id": callback_query_id, "text": text})

    def send_recommendation(self, conn: Connection, recommendation_id: UUID, chat_id: str | int, public_app_url: str) -> None:
        row = conn.execute(
            """
            SELECT r.id, r.rationale, v.title, v.speaker, v.channel_name, v.youtube_url,
                   v.thumbnail_url
            FROM recommendations r JOIN videos v ON v.id = r.video_id
            WHERE r.id = %s
            """,
            (recommendation_id,),
        ).fetchone()
        if not row:
            raise ValueError("Recommendation not found")
        speaker = f"\n{row['speaker']}" if row["speaker"] else ""
        caption = _truncate_utf16(
            f"{row['title']}{speaker}\n{row['channel_name']}\n\n{row['rationale']}", 1000,
        )
        first_line, _, remainder = caption.partition("\n")
        text = f"<b>{html.escape(first_line)}</b>"
        if remainder:
            text += "\n" + html.escape(remainder)
        watch_url = row["youtube_url"]
        payload = {
            "chat_id": chat_id,
            "caption" if row["thumbnail_url"] else "text": text,
            "parse_mode": "HTML",
            "reply_markup": {"inline_keyboard": [
                [{"text": "Watch on YouTube", "url": watch_url}],
                [
                    {"text": "👍 More like this", "callback_data": f"feedback:up:{row['id']}"},
                    {"text": "👎 Less like this", "callback_data": f"feedback:down:{row['id']}"},
                ],
            ]},
        }
        if row["thumbnail_url"]:
            payload["photo"] = row["thumbnail_url"]
        self._call("sendPhoto" if row["thumbnail_url"] else "sendMessage", payload)
