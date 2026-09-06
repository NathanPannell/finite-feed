import os
import hashlib
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app import main
from backend.app.settings import Settings
from backend.app.accounts import consume_telegram_link


def test_private_chat_unlink_preserves_history_and_allows_new_account_link(monkeypatch):
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL required for Telegram account migration")
    old, other, new = uuid4(), uuid4(), uuid4()
    chat = int(uuid4().int % 1000000000) + 9000000000
    messages = []
    monkeypatch.setattr(main, "settings", Settings(_env_file=None, TELEGRAM_PRODUCTION_BOT_TOKEN="test", TELEGRAM_WEBHOOK_SECRET="test"))
    class Bot:
        def __init__(self, token): pass
        def send_text(self, target, text): messages.append((target, text))
    monkeypatch.setattr(main, "TelegramBot", Bot)
    updates = []
    with psycopg.connect(url, row_factory=dict_row) as conn:
        def command(text, kind="private"):
            update = {"update_id": uuid4().int % (2**62), "message": {"chat": {"id": chat, "type": kind}, "text": text}}
            updates.append(update["update_id"])
            return main.telegram_webhook("production", update, "test", conn), update
        try:
            conn.execute("INSERT INTO app_users(id,display_name,telegram_user_id) VALUES (%s,'Legacy',%s),(%s,'Other',%s)", (old,chat,other,chat+1))
            conn.execute("INSERT INTO preference_versions(id,user_id,version,preference_statement,rendered_markdown,source) VALUES (%s,%s,1,'Keep history','Keep history','onboarding')", (uuid4(),old))
            conn.execute("INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at) VALUES (%s,%s,NOW()+INTERVAL '10 minutes')", (str(uuid4()),old))
            conn.commit()
            command("/unlink confirm", "group")
            assert not messages
            command("/unlink")
            assert "/unlink confirm" in messages[-1][1]
            assert conn.execute("SELECT telegram_user_id FROM app_users WHERE id=%s", (old,)).fetchone()["telegram_user_id"] == chat
            _, update = command("/unlink confirm")
            row = conn.execute("SELECT telegram_user_id,delivery_paused FROM app_users WHERE id=%s", (old,)).fetchone()
            assert row == {"telegram_user_id": None, "delivery_paused": True}
            assert conn.execute("SELECT COUNT(*) AS count FROM telegram_link_tokens WHERE user_id=%s", (old,)).fetchone()["count"] == 0
            assert conn.execute("SELECT preference_statement FROM preference_versions WHERE user_id=%s", (old,)).fetchone()["preference_statement"] == "Keep history"
            assert conn.execute("SELECT telegram_user_id FROM app_users WHERE id=%s", (other,)).fetchone()["telegram_user_id"] == chat+1
            assert main.telegram_webhook("production", update, "test", conn)["duplicate"] is True
            command("/unlink confirm")
            assert "Connect Telegram" in messages[-1][1]
            conn.execute("INSERT INTO app_users(id,display_name,auth_subject) VALUES (%s,'New Google account',%s)", (new,str(uuid4())))
            raw = str(uuid4())
            conn.execute("INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at) VALUES (%s,%s,NOW()+INTERVAL '10 minutes')", (hashlib.sha256(raw.encode()).hexdigest(),new))
            conn.commit()
            assert consume_telegram_link(conn,raw,chat) == new
            conn.execute("UPDATE app_users SET telegram_user_id=NULL WHERE id=%s", (new,))
            # A deleted account cannot be resolved as an active bot identity.
            conn.execute("UPDATE app_users SET telegram_user_id=%s,deleted_at=NOW() WHERE id=%s", (chat,old))
            conn.commit()
            command("/unlink confirm")
            assert "Connect Telegram" in messages[-1][1]
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id IN (%s,%s,%s)", (old,other,new))
            for update_id in updates:
                conn.execute("DELETE FROM telegram_updates WHERE bot_kind='production' AND update_id=%s", (update_id,))
            conn.commit()
