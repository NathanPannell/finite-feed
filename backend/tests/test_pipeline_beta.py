from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

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


def test_model_rationale_is_trimmed_to_one_sentence():
    client = OpenRouterClient("test", "test", "https://example.com", "https://example.com")
    client.client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        "model": "test",
        "choices": [{"message": {"content": '{"video_id": "fit", "rationale": "This fits you. A second sentence should go."}'}}],
    })), base_url="https://example.com")
    try:
        choice = client.choose("useful talks", [{"video_id": "fit"}])
        assert choice.rationale == "This fits you."
    finally:
        client.close()


@pytest.mark.parametrize("failure", ["no_key", "quota", "http", "timeout", "malformed"])
def test_recommendation_provider_failures_persist_nearest_cosine_match(monkeypatch, failure):
    import os
    import psycopg
    from psycopg.rows import dict_row
    from backend.app import recommendations as recs
    from backend.app.settings import Settings

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")
    user_id, profile_id = uuid4(), uuid4()
    nearest_id, composite_id = uuid4(), uuid4()
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        channel_id = conn.execute("SELECT id FROM tracked_channels LIMIT 1").fetchone()["id"]
        try:
            conn.execute("UPDATE tracked_channels SET is_active=TRUE WHERE id=%s", (channel_id,))
            conn.execute("INSERT INTO app_users(id,display_name) VALUES (%s,'Fallback choice')", (user_id,))
            conn.execute(
                "INSERT INTO preference_versions(id,user_id,version,preference_statement,rendered_markdown,source) "
                "VALUES (%s,%s,1,'precise preference','precise preference','onboarding')",
                (profile_id, user_id),
            )
            conn.execute("INSERT INTO user_channel_follows(user_id,channel_id) VALUES (%s,%s)", (user_id, channel_id))
            for video_id, title in ((nearest_id, "Nearest"), (composite_id, "Composite")):
                conn.execute(
                    "INSERT INTO videos(id,youtube_video_id,tracked_channel_id,channel_name,title,description,youtube_url) "
                    "VALUES (%s,%s,%s,'test',%s,%s,%s)",
                    (video_id, str(video_id), channel_id, title, title, f"https://youtu.be/{video_id}"),
                )
            conn.commit()
            shortlist = [
                recs.ScoredVideo({"id": composite_id, "youtube_video_id": str(composite_id), "title": "Composite", "speaker": None, "channel_name": "test", "description": "Composite", "published_at": None}, 0.70, 1.0, 0.99),
                recs.ScoredVideo({"id": nearest_id, "youtube_video_id": str(nearest_id), "title": "Nearest", "speaker": None, "channel_name": "test", "description": "Nearest", "published_at": None}, 0.91, 0.0, 0.65),
            ]
            monkeypatch.setattr(recs, "retrieve_shortlist", lambda *args, **kwargs: shortlist)
            if failure != "quota":
                monkeypatch.setattr(recs, "reserve_request", lambda connection, *args: connection.commit())

            def fail(*args):
                if failure == "http":
                    request = httpx.Request("POST", "https://example.test/chat/completions")
                    raise httpx.HTTPStatusError("failed", request=request, response=httpx.Response(503, request=request))
                if failure == "timeout":
                    raise httpx.ReadTimeout("timed out")
                raise ValueError("malformed")

            provider_calls = []
            def client(*args):
                provider_calls.append(args)
                return SimpleNamespace(choose=fail, close=lambda: None)
            monkeypatch.setattr(recs, "OpenRouterClient", client)
            encoder = SimpleNamespace(model_name="test", model_revision="test", dimensions=384)
            settings = Settings(
                _env_file=None, OPENROUTER_API_KEY="" if failure == "no_key" else "test",
                MODEL_DAILY_REQUEST_LIMIT=0 if failure == "quota" else 40,
            )
            recommendation_id = recs.generate_recommendation(conn, settings, user_id, True, encoder)
            row = conn.execute(
                "SELECT video_id,rationale,evidence FROM recommendations WHERE id=%s", (recommendation_id,),
            ).fetchone()
            assert row["video_id"] == nearest_id
            assert "cosine similarity" in row["rationale"]
            assert row["evidence"]["reranker_fallback"] is True
            assert row["evidence"]["reranker_error"] == ("missing_api_key" if failure == "no_key" else {
                "quota": "request_budget_exhausted", "http": "HTTPStatusError",
                "timeout": "ReadTimeout", "malformed": "ValueError",
            }[failure])
            assert bool(provider_calls) is (failure not in {"no_key", "quota"})
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.execute("DELETE FROM videos WHERE id=ANY(%s)", ([nearest_id, composite_id],))
            conn.commit()


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


def test_telegram_recommendation_uses_thumbnail_and_bounded_caption(monkeypatch):
    calls = []
    recommendation_id = uuid4()

    class Result:
        def fetchone(self):
            return {
                "id": recommendation_id,
                "title": "A <useful> title",
                "speaker": "Speaker",
                "channel_name": "Channel",
                "rationale": "😀" * 1200,
                "youtube_url": "https://youtu.be/example",
                "thumbnail_url": "https://i.ytimg.com/example.jpg",
            }

    bot = TelegramBot("test")
    monkeypatch.setattr(TelegramBot, "_call", lambda self, method, payload: calls.append((method, payload)))
    bot.send_recommendation(SimpleNamespace(execute=lambda *args: Result()), recommendation_id, 123, "https://app.test")

    method, payload = calls[0]
    assert method == "sendPhoto"
    assert payload["photo"] == "https://i.ytimg.com/example.jpg"
    assert len(payload["caption"].encode("utf-16-le")) // 2 <= 1024
    assert payload["reply_markup"]["inline_keyboard"][0][0]["url"] == "https://youtu.be/example"


def test_preference_confirmation_has_exact_copy_and_bounded_callbacks(monkeypatch):
    calls = []
    confirmation_id = uuid4()
    bot = TelegramBot("test")
    monkeypatch.setattr(TelegramBot, "_call", lambda self, method, payload: calls.append((method, payload)))
    bot.send_preference_confirmation(123, confirmation_id, "more practical engineering")

    method, payload = calls[0]
    assert method == "sendMessage"
    assert payload["text"] == "Adding 'more practical engineering' to preferences, is that okay?"
    buttons = payload["reply_markup"]["inline_keyboard"][0]
    assert [button["text"] for button in buttons] == ["Yes, update", "No, don't update"]
    assert all(len(button["callback_data"].encode()) <= 64 for button in buttons)

    calls.clear()
    bot.send_preference_confirmation(123, confirmation_id, "😀" * 4096)
    assert len(calls[0][1]["text"].encode("utf-16-le")) // 2 <= 4096
    assert calls[0][1]["text"].endswith("' to preferences, is that okay?")


@pytest.mark.parametrize("current_chat,current_completed", [
    (None, True), ("healthy", True), ("relinked-chat", True), ("healthy", False),
])
def test_delivery_continues_after_recipient_failure_and_honors_count(monkeypatch, current_chat, current_completed):
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
            return SimpleNamespace(fetchone=lambda: {
                "delivery_paused": False,
                "deleted_at": None,
                "telegram_user_id": current_chat,
                "onboarding_completed_at": datetime.now(UTC) if current_completed else None,
            })
        def commit(self):
            pass
        def rollback(self):
            pass
    class Pool:
        @contextmanager
        def connection(self):
            yield Connection()
    sent = []
    def claim(conn, user, require_model):
        if user == "blocked":
            raise RuntimeError("blocked")
        return "recommendation"
    monkeypatch.setattr(worker, "get_settings", lambda: Settings(_env_file=None, OPENROUTER_API_KEY="test", TELEGRAM_PRODUCTION_BOT_TOKEN="test"))
    monkeypatch.setattr(worker, "claim_delivery_attempt", lambda *args: True)
    monkeypatch.setattr(worker, "claim_queued_recommendation", claim)
    monkeypatch.setattr(worker, "lock_recommendation_for_delivery", lambda *args: True)
    monkeypatch.setattr(worker, "mark_recommendation_delivered", lambda *args, **kwargs: None)
    monkeypatch.setattr(worker, "TelegramBot", lambda _: SimpleNamespace(send_recommendation=lambda *args: sent.append(args[2])))
    worker.run_delivery_pass(Pool())
    assert sent == ([current_chat, current_chat] if current_chat is not None and current_completed else [])


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


@pytest.mark.parametrize("mutation", ["delete", "preferences", "unfollow"])
def test_generation_rechecks_account_after_provider_call(monkeypatch, mutation):
    import os
    from uuid import uuid4
    import psycopg
    from psycopg.rows import dict_row
    from backend.app import recommendations as recs
    from backend.app.settings import Settings
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")
    user_id, video_id, profile_id = uuid4(), uuid4(), uuid4()
    monkeypatch.setattr(recs, "reserve_request", lambda connection, *args: connection.commit())
    with psycopg.connect(database_url, row_factory=dict_row) as conn, psycopg.connect(database_url, row_factory=dict_row) as other:
        channel_id = conn.execute("SELECT id FROM tracked_channels LIMIT 1").fetchone()["id"]
        conn.execute("INSERT INTO app_users (id, display_name) VALUES (%s, 'Concurrency test')", (user_id,))
        conn.execute("INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source) VALUES (%s, %s, 1, 'football', 'football', 'onboarding')", (profile_id, user_id))
        conn.execute("INSERT INTO user_channel_follows (user_id, channel_id) VALUES (%s, %s)", (user_id, channel_id))
        conn.execute("INSERT INTO videos (id, youtube_video_id, tracked_channel_id, channel_name, title, youtube_url) VALUES (%s, %s, %s, 'test', 'football', 'https://youtu.be/test')", (video_id, str(video_id), channel_id))
        conn.commit()
        video = {"id": video_id, "youtube_video_id": str(video_id), "title": "football", "speaker": None, "channel_name": "test", "description": "football", "published_at": None}
        monkeypatch.setattr(recs, "retrieve_shortlist", lambda *args, **kwargs: [recs.ScoredVideo(video, 0.9, 0, 0.648)])
        def choose(*args):
            other.execute("SET LOCAL lock_timeout = '1s'")
            other.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (user_id,))
            if mutation == "delete":
                other.execute("UPDATE app_users SET deleted_at = NOW() WHERE id = %s", (user_id,))
                other.execute("DELETE FROM preference_versions WHERE user_id = %s", (user_id,))
            elif mutation == "preferences":
                other.execute("INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source) VALUES (%s, %s, 2, 'pottery', 'pottery', 'dashboard')", (uuid4(), user_id))
            else:
                other.execute("DELETE FROM user_channel_follows WHERE user_id = %s", (user_id,))
            other.commit()
            return SimpleNamespace(video_id=str(video_id), rationale="a choice", model="test")
        monkeypatch.setattr(recs, "OpenRouterClient", lambda *args: SimpleNamespace(choose=choose, close=lambda: None))
        encoder = SimpleNamespace(model_name="test", model_revision="test", dimensions=384)
        try:
            # Match the endpoint's account lock before quota reservation releases it.
            conn.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (user_id,))
            with pytest.raises(ValueError, match="no longer active|preferences changed|sources changed"):
                recs.generate_recommendation(conn, Settings(_env_file=None, OPENROUTER_API_KEY="test"), user_id, True, encoder)
            conn.rollback()
            assert conn.execute("SELECT COUNT(*) AS count FROM recommendations WHERE user_id = %s", (user_id,)).fetchone()["count"] == 0
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id = %s", (user_id,))
            conn.execute("DELETE FROM videos WHERE id = %s", (video_id,))
            conn.commit()


@pytest.mark.parametrize("outcome", ["empty", "unavailable"])
def test_telegram_command_is_handled_once_when_queue_is_empty_or_unavailable(monkeypatch, outcome):
    import os
    from uuid import uuid4
    import psycopg
    from psycopg.rows import dict_row
    from backend.app import main as api
    from backend.app.settings import Settings
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")
    user_id, chat_id, update_id = uuid4(), uuid4().int % (2**62), uuid4().int % (2**62)
    calls, messages = [], []
    monkeypatch.setattr(api, "settings", Settings(_env_file=None, TELEGRAM_WEBHOOK_SECRET="test", TELEGRAM_PRODUCTION_BOT_TOKEN="test"))
    monkeypatch.setattr(api, "TelegramBot", lambda *args: SimpleNamespace(send_text=lambda *args: messages.append(args), send_recommendation=lambda *args: pytest.fail("must not send a recommendation")))
    with psycopg.connect(database_url, row_factory=dict_row) as conn, psycopg.connect(database_url, row_factory=dict_row) as other:
        conn.execute("INSERT INTO app_users (id, display_name, telegram_user_id) VALUES (%s, 'Webhook test', %s)", (user_id, chat_id))
        conn.commit()
        def claim(*args, **kwargs):
            calls.append(1)
            if outcome == "unavailable":
                raise RuntimeError("provider unavailable")
            return None
        monkeypatch.setattr(api, "claim_queued_recommendation", claim)
        update = {"update_id": update_id, "message": {"chat": {"id": chat_id, "type": "private"}, "text": "/recommend"}}
        try:
            assert api.telegram_webhook("production", update, "test", conn) == {"ok": True}
            assert api.telegram_webhook("production", update, "test", conn) == {"ok": True, "duplicate": True}
            assert len(calls) == 1
            assert len(messages) == 1
        finally:
            conn.rollback()
            conn.execute("DELETE FROM telegram_updates WHERE bot_kind = 'production' AND update_id = %s", (update_id,))
            conn.execute("DELETE FROM app_users WHERE id = %s", (user_id,))
            conn.commit()
