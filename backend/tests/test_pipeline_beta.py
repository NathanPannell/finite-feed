from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

from backend.app.openrouter import OpenRouterClient
from backend.app.telegram import TelegramBot
from backend.evals import run_recommendation_eval as evaluation
from backend.worker.main import delivery_is_due


def test_live_eval_failure_is_nonzero_without_provider_call(monkeypatch):
    monkeypatch.setattr("sys.argv", ["eval", "--with-model"])
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    monkeypatch.setattr(evaluation, "configured_embedder", lambda _: None)
    monkeypatch.setattr(evaluation, "retrieval_winner", lambda case, _: case["expected_video_id"])
    monkeypatch.setattr(evaluation, "legacy_winner", lambda case: "wrong")
    monkeypatch.setattr(evaluation, "OpenRouterClient", lambda *args: SimpleNamespace(
        choose=lambda *args: SimpleNamespace(video_id="wrong"), close=lambda: None))
    assert evaluation.main() == 1


def test_model_can_abstain():
    client = OpenRouterClient("test", "test", "https://example.com", "https://example.com")
    client.client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        "choices": [{"message": {"content": '{"video_id": null, "rationale": "No strong fit."}'}}]
    })), base_url="https://example.com")
    try:
        assert client.choose("only football", [{"video_id": "pottery"}]).video_id is None
    finally:
        client.close()


def test_dst_repeated_hour_and_pause():
    user = {"timezone": "America/Los_Angeles", "cadence_days": [0], "delivery_hour": 1}
    first = datetime(2026, 11, 1, 8, 15, tzinfo=UTC)
    second = datetime(2026, 11, 1, 9, 15, tzinfo=UTC)
    assert delivery_is_due(user, None, second)
    assert not delivery_is_due(user, first, second)
    assert not delivery_is_due({**user, "delivery_paused": True}, None, second)


def test_telegram_failure_never_exposes_token(monkeypatch):
    def fail(*args, **kwargs):
        raise httpx.ConnectError("https://api.telegram.org/botSECRET/sendMessage")
    monkeypatch.setattr(httpx, "post", fail)
    with pytest.raises(RuntimeError, match="retry after cooldown") as exc:
        TelegramBot("SECRET").send_text(1, "hello")
    assert "SECRET" not in str(exc.value)


def test_delivery_continues_after_recipient_failure_and_honors_count(monkeypatch):
    from contextlib import contextmanager
    from backend.worker import main as worker
    from backend.app.settings import Settings

    users = [{"id": name, "telegram_user_id": name, "timezone": "UTC", "cadence_days": list(range(7)),
              "delivery_hour": 0, "recommendation_count": 3, "delivery_paused": False} for name in ("blocked", "healthy")]
    class Connection:
        def execute(self, query, params=()):
            if "FROM app_users WHERE telegram_user_id" in query:
                return SimpleNamespace(fetchall=lambda: users)
            if "COUNT(*)" in query:
                return SimpleNamespace(fetchone=lambda: {"count": 1})
            return SimpleNamespace(fetchone=lambda: {"delivery_paused": False, "deleted_at": None})
        def commit(self):
            pass
        def rollback(self):
            pass
    class Pool:
        @contextmanager
        def connection(self):
            yield Connection()
    sent = []
    def generate(conn, settings, user, require_model):
        if user == "blocked":
            raise RuntimeError("blocked")
        return "recommendation"
    monkeypatch.setattr(worker, "get_settings", lambda: Settings(_env_file=None, OPENROUTER_API_KEY="test", TELEGRAM_PRODUCTION_BOT_TOKEN="test"))
    monkeypatch.setattr(worker, "claim_delivery_attempt", lambda *args: True)
    monkeypatch.setattr(worker, "get_or_create_pending_recommendation", generate)
    monkeypatch.setattr(worker, "lock_recommendation_for_delivery", lambda *args: True)
    monkeypatch.setattr(worker, "mark_recommendation_delivered", lambda *args, **kwargs: None)
    monkeypatch.setattr(worker, "TelegramBot", lambda _: SimpleNamespace(send_recommendation=lambda *args: sent.append(args[2])))
    worker.run_delivery_pass(Pool())
    assert sent == ["healthy", "healthy"]


def test_persisted_quota_counts_failures_and_stops_at_limit():
    import os
    from uuid import uuid4
    import psycopg
    from psycopg.rows import dict_row
    from backend.app.budgets import reserve_request
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")
    provider = "test-" + str(uuid4())
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        try:
            reserve_request(conn, provider, 1)
            conn.rollback()  # A downstream provider failure cannot refund its attempted request.
            with pytest.raises(ValueError, match="budget exhausted"):
                reserve_request(conn, provider, 1)
            assert conn.execute("SELECT requests FROM provider_daily_usage WHERE provider = %s", (provider,)).fetchone()["requests"] == 1
        finally:
            conn.execute("DELETE FROM provider_daily_usage WHERE provider = %s", (provider,))
            conn.commit()


def test_feedback_changes_ranking_with_bounded_influence():
    from backend.app.recommendations import ScoredVideo, apply_feedback
    class Encoder:
        def embed_documents(self, texts):
            return [[1.0, 0.0] if "football" in text else [0.0, 1.0] for text in texts]
    pottery = ScoredVideo({"title": "pottery", "description": "pottery"}, 0.8, 0, 0.576)
    football = ScoredVideo({"title": "football", "description": "football"}, 0.8, 0, 0.576)
    more = [{"rating": "up", "title": "football", "description": "football"}]
    less = [{**more[0], "rating": "down"}]
    assert apply_feedback([pottery, football], more, Encoder())[0].row["title"] == "football"
    assert apply_feedback([football, pottery], less, Encoder())[0].row["title"] == "pottery"
    assert apply_feedback([football], more, Encoder())[0].score <= football.score + 0.12
