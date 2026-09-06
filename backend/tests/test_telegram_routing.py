from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from backend.app import accounts
from backend.app.settings import Settings
from backend.worker import main as worker


class Connection:
    def __init__(self):
        self.writes = []
    def execute(self, query, params=()):
        self.writes.append(query)
        if "RETURNING token_hash" in query:
            return SimpleNamespace(fetchone=lambda: {"token_hash": params[0]})
        return SimpleNamespace(fetchone=lambda: None)
    def commit(self):
        pass


def configure(monkeypatch, preview=True, **overrides):
    settings = Settings(_env_file=None, **{
        "RAILWAY_ENVIRONMENT_NAME": "pr-35" if preview else "production",
        "TELEGRAM_DEVELOPER_BOT_TOKEN": "developer-test",
        "TELEGRAM_PRODUCTION_BOT_TOKEN": "production-test",
        "TELEGRAM_WEBHOOK_SECRET": "test-secret",
        "DEVELOPER_TELEGRAM_USER_IDS": "123",
        "PUBLIC_APP_URL": "https://preview.example.com" if preview else "https://production.example.com",
        **overrides,
    })
    calls = []
    def bot(token):
        return SimpleNamespace(set_webhook=lambda url, secret: calls.append((token, url)),
                               _call=lambda *args: {"result": {"username": "test_bot"}})
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(worker, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "TelegramBot", bot)
    monkeypatch.setattr(worker, "TelegramBot", bot)
    return calls


def test_preview_connect_claims_only_developer_webhook(monkeypatch):
    calls = configure(monkeypatch)
    conn = Connection()
    result = accounts.telegram_link(uuid4(), conn)
    assert calls == [("developer-test", "https://preview.example.com/telegram/webhook/developer")]
    assert result["url"].startswith("https://t.me/test_bot?start=")
    assert len(result["code"]) == 6 and result["code"].isdigit()
    assert any("'manual_code'" in query for query in conn.writes)
    worker.configure_webhooks()
    assert len(calls) == 1


def test_production_worker_recovers_only_production_bot(monkeypatch):
    calls = configure(monkeypatch, preview=False)
    worker.configure_webhooks()
    assert calls == [("production-test", "https://production.example.com/telegram/webhook/production")]
    accounts.telegram_link(uuid4(), Connection())
    assert len(calls) == 1


@pytest.mark.parametrize("missing", [{"TELEGRAM_WEBHOOK_SECRET": ""}, {"DEVELOPER_TELEGRAM_USER_IDS": ""}, {"PUBLIC_APP_URL": "http://preview.example.com"}])
def test_preview_link_fails_before_creating_token_without_safe_routing(monkeypatch, missing):
    calls = configure(monkeypatch, **missing)
    conn = Connection()
    with pytest.raises(HTTPException) as exc:
        accounts.telegram_link(uuid4(), conn)
    assert exc.value.status_code == 503
    assert not calls and not conn.writes


def test_webhook_failure_returns_safe_error_without_token(monkeypatch):
    configure(monkeypatch)
    def fail(*args):
        raise RuntimeError("sensitive provider detail")
    monkeypatch.setattr(accounts, "TelegramBot", lambda *args: SimpleNamespace(set_webhook=fail))
    conn = Connection()
    with pytest.raises(HTTPException) as exc:
        accounts.telegram_link(uuid4(), conn)
    assert exc.value.status_code == 503
    assert "sensitive" not in exc.value.detail
    assert not conn.writes
