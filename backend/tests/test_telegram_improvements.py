import hashlib
import os
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from backend.app import accounts, main
from backend.app.accounts import consume_telegram_link
from backend.app.settings import Settings


@pytest.fixture
def database_url():
    value = os.environ.get("DATABASE_URL")
    if not value:
        pytest.skip("DATABASE_URL is required")
    return value


def _create_user(conn, *, chat_id=None):
    user_id, profile_id = uuid4(), uuid4()
    conn.execute(
        "INSERT INTO app_users(id,display_name,telegram_user_id) VALUES (%s,'Telegram improvements',%s)",
        (user_id, chat_id),
    )
    conn.execute(
        """INSERT INTO preference_versions
           (id,user_id,version,preference_statement,rendered_markdown,source)
           VALUES (%s,%s,1,'Existing preference','# Current preferences','onboarding')""",
        (profile_id, user_id),
    )
    conn.commit()
    return user_id, profile_id


def test_manual_code_and_deep_link_are_single_use_and_code_attempts_are_limited(
    database_url, monkeypatch,
):
    monkeypatch.setattr(
        accounts, "get_settings",
        lambda: Settings(_env_file=None, TELEGRAM_PRODUCTION_BOT_TOKEN="test"),
    )
    monkeypatch.setattr(
        accounts, "TelegramBot",
        lambda _: SimpleNamespace(_call=lambda *args: {"result": {"username": "finite_feed_test_bot"}}),
    )
    chat_id = uuid4().int % 2_000_000_000 + 7_000_000_000
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        user_id, _ = _create_user(conn)
        try:
            link = accounts.telegram_link(user_id, conn)
            assert len(link["code"]) == 6 and link["code"].isdigit()
            assert parse_qs(urlparse(link["url"]).query)["start"][0]
            assert conn.execute(
                "SELECT COUNT(*) AS count FROM telegram_link_tokens WHERE user_id=%s",
                (user_id,),
            ).fetchone()["count"] == 2

            assert consume_telegram_link(conn, link["code"], chat_id) == user_id
            assert consume_telegram_link(conn, link["code"], chat_id) is None
            conn.commit()
            assert conn.execute(
                "SELECT COUNT(*) AS count FROM telegram_link_tokens WHERE user_id=%s",
                (user_id,),
            ).fetchone()["count"] == 0

            conn.execute("UPDATE app_users SET telegram_user_id=NULL WHERE id=%s", (user_id,))
            conn.commit()
            for index in range(6):
                assert consume_telegram_link(conn, f"8{index:05d}", chat_id + 1) is None
                conn.commit()
            attempts = conn.execute(
                "SELECT attempt_count FROM telegram_link_attempts WHERE chat_id=%s", (chat_id + 1,),
            ).fetchone()
            assert attempts["attempt_count"] == 6

            expired_code = f"{uuid4().int % 1_000_000:06d}"
            conn.execute(
                """INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at,kind)
                   VALUES (%s,%s,NOW()-INTERVAL '1 second','manual_code')""",
                (hashlib.sha256(expired_code.encode()).hexdigest(), user_id),
            )
            conn.commit()
            assert consume_telegram_link(conn, expired_code, chat_id + 2) is None
            conn.commit()
        finally:
            conn.rollback()
            conn.execute(
                "DELETE FROM telegram_link_attempts WHERE chat_id IN (%s,%s,%s)",
                (chat_id, chat_id + 1, chat_id + 2),
            )
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_confirmation_is_bound_superseded_append_only_and_replay_safe(database_url, monkeypatch):
    chat_id = uuid4().int % 2_000_000_000 + 7_000_000_000
    messages, answers = [], []

    class Bot:
        def __init__(self, _):
            pass

        def send_text(self, *args):
            messages.append(args)

        def send_preference_confirmation(self, *args):
            messages.append(args)

        def answer_callback(self, *args):
            answers.append(args)

    monkeypatch.setattr(
        main, "settings",
        Settings(_env_file=None, TELEGRAM_PRODUCTION_BOT_TOKEN="test", TELEGRAM_WEBHOOK_SECRET="test"),
    )
    monkeypatch.setattr(main, "TelegramBot", Bot)
    update_ids = []
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        user_id, _ = _create_user(conn, chat_id=chat_id)

        def webhook(text=None, callback_data=None, callback_user=None):
            update_id = uuid4().int % (2**62)
            update_ids.append(update_id)
            message = {"chat": {"id": chat_id, "type": "private"}}
            update = {"update_id": update_id, "message": {**message, "text": text or ""}}
            if callback_data:
                update = {"update_id": update_id, "callback_query": {
                    "id": str(uuid4()), "data": callback_data,
                    "from": {"id": callback_user if callback_user is not None else chat_id},
                    "message": message,
                }}
            return main.telegram_webhook("production", update, "test", conn)

        try:
            webhook("first addition")
            first = conn.execute(
                "SELECT id,resolved_at FROM telegram_preference_confirmations WHERE user_id=%s ORDER BY created_at",
                (user_id,),
            ).fetchone()
            webhook("second addition")
            rows = conn.execute(
                "SELECT id,resolved_at FROM telegram_preference_confirmations WHERE user_id=%s ORDER BY created_at",
                (user_id,),
            ).fetchall()
            assert rows[0]["id"] == first["id"] and rows[0]["resolved_at"] is not None
            active_id = rows[1]["id"]

            webhook(callback_data=f"preference:yes:{active_id}", callback_user=chat_id + 99)
            assert conn.execute(
                "SELECT resolved_at FROM telegram_preference_confirmations WHERE id=%s", (active_id,),
            ).fetchone()["resolved_at"] is None

            webhook(callback_data=f"preference:yes:{active_id}")
            profile = conn.execute(
                "SELECT version,preference_statement FROM preference_versions WHERE user_id=%s ORDER BY version DESC LIMIT 1",
                (user_id,),
            ).fetchone()
            assert profile == {"version": 2, "preference_statement": "Existing preference\n\nsecond addition"}
            assert conn.execute(
                "SELECT COUNT(*) AS count FROM telegram_recommendation_queue WHERE user_id=%s AND status='pending'",
                (user_id,),
            ).fetchone()["count"] == 2

            webhook(callback_data=f"preference:yes:{active_id}")
            assert conn.execute(
                "SELECT MAX(version) AS version FROM preference_versions WHERE user_id=%s", (user_id,),
            ).fetchone()["version"] == 2
            assert "already handled" in answers[-1][1]

            # Numeric text from an already linked user remains a preference proposal.
            webhook("123456")
            assert messages[-1][2] == "123456"
            numeric_id = messages[-1][1]
            conn.execute(
                "UPDATE telegram_preference_confirmations SET expires_at=NOW()-INTERVAL '1 second' WHERE id=%s",
                (numeric_id,),
            )
            conn.commit()
            webhook(callback_data=f"preference:yes:{numeric_id}")
            assert conn.execute(
                "SELECT MAX(version) AS version FROM preference_versions WHERE user_id=%s", (user_id,),
            ).fetchone()["version"] == 2

            webhook("declined addition")
            declined_id = messages[-1][1]
            webhook(callback_data=f"preference:no:{declined_id}")
            declined = conn.execute(
                "SELECT resolved_at,accepted FROM telegram_preference_confirmations WHERE id=%s", (declined_id,),
            ).fetchone()
            assert declined["resolved_at"] is not None and declined["accepted"] is False
            assert conn.execute(
                "SELECT MAX(version) AS version FROM preference_versions WHERE user_id=%s", (user_id,),
            ).fetchone()["version"] == 2
        finally:
            conn.rollback()
            for update_id in update_ids:
                conn.execute(
                    "DELETE FROM telegram_updates WHERE bot_kind='production' AND update_id=%s", (update_id,),
                )
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_recommend_command_consumes_two_ready_slots_then_retries_after_empty(database_url, monkeypatch):
    chat_id = uuid4().int % 2_000_000_000 + 7_000_000_000
    sent, messages, update_ids, video_ids = [], [], [], []

    class Bot:
        def __init__(self, _):
            pass

        def send_text(self, _, text):
            messages.append(text)

        def send_recommendation(self, _, recommendation_id, *__):
            sent.append(recommendation_id)

    monkeypatch.setattr(
        main, "settings",
        Settings(_env_file=None, TELEGRAM_PRODUCTION_BOT_TOKEN="test", TELEGRAM_WEBHOOK_SECRET="test"),
    )
    monkeypatch.setattr(main, "TelegramBot", Bot)
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        user_id, profile_id = _create_user(conn, chat_id=chat_id)
        channel_id = conn.execute("SELECT id FROM tracked_channels WHERE is_active LIMIT 1").fetchone()["id"]
        conn.execute(
            "INSERT INTO user_channel_follows(user_id,channel_id) VALUES (%s,%s)", (user_id, channel_id),
        )

        def add_ready(slot):
            video_id, recommendation_id = uuid4(), uuid4()
            video_ids.append(video_id)
            conn.execute(
                """INSERT INTO videos
                   (id,youtube_video_id,tracked_channel_id,channel_name,title,youtube_url)
                   VALUES (%s,%s,%s,'Test channel','Queued video','https://youtu.be/test')""",
                (video_id, str(video_id), channel_id),
            )
            conn.execute(
                """INSERT INTO recommendations
                   (id,user_id,video_id,preference_version_id,rationale,evidence)
                   VALUES (%s,%s,%s,%s,'Queued rationale',%s)""",
                (recommendation_id, user_id, video_id, profile_id, Jsonb({"reranker_fallback": False})),
            )
            conn.execute(
                """INSERT INTO telegram_recommendation_queue
                   (user_id,slot,preference_version_id,recommendation_id,status)
                   VALUES (%s,%s,%s,%s,'ready')
                   ON CONFLICT (user_id,slot) DO UPDATE SET
                     preference_version_id=EXCLUDED.preference_version_id,
                     recommendation_id=EXCLUDED.recommendation_id,status='ready'""",
                (user_id, slot, profile_id, recommendation_id),
            )
            conn.commit()
            return recommendation_id

        expected = [add_ready(1), add_ready(2)]

        def recommend():
            update_id = uuid4().int % (2**62)
            update_ids.append(update_id)
            update = {"update_id": update_id, "message": {
                "chat": {"id": chat_id, "type": "private"}, "text": "/recommend",
            }}
            return main.telegram_webhook("production", update, "test", conn)

        try:
            recommend()
            recommend()
            assert sent == expected
            recommend()
            assert messages[-1] == "Your next recommendation is being prepared. Try again shortly."
            assert conn.execute(
                "SELECT last_delivery_attempt_at FROM app_users WHERE id=%s", (user_id,),
            ).fetchone()["last_delivery_attempt_at"] is None

            third = add_ready(1)
            # A successful/empty scheduled pass may leave its cadence timestamp;
            # without an error it must not throttle an explicit command.
            conn.execute(
                "UPDATE app_users SET last_delivery_attempt_at=NOW(),delivery_error=NULL WHERE id=%s",
                (user_id,),
            )
            conn.commit()
            recommend()
            assert sent == [*expected, third]
        finally:
            conn.rollback()
            for update_id in update_ids:
                conn.execute(
                    "DELETE FROM telegram_updates WHERE bot_kind='production' AND update_id=%s", (update_id,),
                )
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            for video_id in video_ids:
                conn.execute("DELETE FROM videos WHERE id=%s", (video_id,))
            conn.commit()
