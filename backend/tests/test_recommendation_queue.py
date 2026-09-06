import os
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app.recommendation_queue import (
    claim_queued_recommendation,
    ensure_recommendation_queue,
    invalidate_recommendation_queue,
    refill_recommendation_queue,
)
from backend.app.recommendations import mark_recommendation_delivered
from backend.app.settings import Settings


def _database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if not value:
        pytest.skip("DATABASE_URL is required")
    return value


def _seed_user(conn, recommendation_count: int = 2):
    user_id, profile_id = uuid4(), uuid4()
    conn.execute(
        "INSERT INTO app_users (id, display_name, telegram_user_id) VALUES (%s, 'Queue test', %s)",
        (user_id, user_id.int % (2**62)),
    )
    conn.execute(
        """INSERT INTO preference_versions
           (id, user_id, version, preference_statement, rendered_markdown, source)
           VALUES (%s, %s, 1, 'useful talks', 'useful talks', 'onboarding')""",
        (profile_id, user_id),
    )
    channel_id = conn.execute("SELECT id FROM tracked_channels ORDER BY created_at LIMIT 1").fetchone()["id"]
    conn.execute("UPDATE tracked_channels SET is_active = TRUE WHERE id = %s", (channel_id,))
    conn.execute(
        "INSERT INTO user_channel_follows (user_id, channel_id) VALUES (%s, %s)",
        (user_id, channel_id),
    )
    video_ids, recommendation_ids = [], []
    for index in range(recommendation_count):
        video_id, recommendation_id = uuid4(), uuid4()
        video_ids.append(video_id)
        recommendation_ids.append(recommendation_id)
        conn.execute(
            """INSERT INTO videos
               (id, youtube_video_id, tracked_channel_id, channel_name, title, youtube_url)
               VALUES (%s, %s, %s, 'Queue', %s, %s)""",
            (video_id, str(video_id), channel_id, f"Queue video {index}", f"https://youtu.be/{video_id}"),
        )
        conn.execute(
            """INSERT INTO recommendations
               (id, user_id, video_id, preference_version_id, rationale, evidence)
               VALUES (%s, %s, %s, %s, 'Good fit.', '{"reranker_fallback": false}')""",
            (recommendation_id, user_id, video_id, profile_id),
        )
    conn.commit()
    return user_id, profile_id, recommendation_ids


def test_queue_claims_two_distinct_current_recommendations_without_generation():
    database_url = _database_url()
    with (
        psycopg.connect(database_url, row_factory=dict_row) as first,
        psycopg.connect(database_url, row_factory=dict_row) as second,
    ):
        user_id, profile_id, recommendation_ids = _seed_user(first)
        try:
            ensure_recommendation_queue(first, user_id)
            for slot, recommendation_id in enumerate(recommendation_ids, 1):
                first.execute(
                    """UPDATE telegram_recommendation_queue
                       SET recommendation_id = %s, status = 'ready'
                       WHERE user_id = %s AND slot = %s""",
                    (recommendation_id, user_id, slot),
                )
            first.commit()

            claimed_first = claim_queued_recommendation(first, user_id)
            assert claimed_first == recommendation_ids[0]
            mark_recommendation_delivered(first, user_id, claimed_first, scheduled=False)
            claimed_second = claim_queued_recommendation(second, user_id)
            assert claimed_second == recommendation_ids[1]
            second.rollback()
            slot = first.execute(
                """SELECT status, recommendation_id FROM telegram_recommendation_queue
                   WHERE user_id = %s AND slot = 1""",
                (user_id,),
            ).fetchone()
            assert slot == {"status": "pending", "recommendation_id": None}

            replacement = uuid4()
            first.execute(
                """INSERT INTO preference_versions
                   (id, user_id, version, preference_statement, rendered_markdown, source)
                   VALUES (%s, %s, 2, 'new interests', 'new interests', 'telegram')""",
                (replacement, user_id),
            )
            invalidate_recommendation_queue(first, user_id)
            first.commit()
            assert claim_queued_recommendation(first, user_id) is None
            rows = first.execute(
                """SELECT preference_version_id, status, recommendation_id
                   FROM telegram_recommendation_queue WHERE user_id = %s ORDER BY slot""",
                (user_id,),
            ).fetchall()
            assert rows == [
                {"preference_version_id": replacement, "status": "pending", "recommendation_id": None},
                {"preference_version_id": replacement, "status": "pending", "recommendation_id": None},
            ]
        finally:
            first.rollback()
            first.execute("DELETE FROM app_users WHERE id = %s", (user_id,))
            first.commit()


def test_refill_releases_account_lock_during_model_work_and_persists_retry(monkeypatch):
    database_url = _database_url()
    with (
        psycopg.connect(database_url, row_factory=dict_row) as conn,
        psycopg.connect(database_url, row_factory=dict_row) as observer,
    ):
        user_id, _, recommendation_ids = _seed_user(conn)
        conn.execute(
            "UPDATE recommendations SET evidence = '{\"reranker_fallback\": true}' WHERE user_id = %s",
            (user_id,),
        )
        conn.commit()
        generated = iter(recommendation_ids)
        calls = []

        def generate(*args, **kwargs):
            observer.execute("SET LOCAL lock_timeout = '1s'")
            observer.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (user_id,))
            observer.rollback()
            calls.append(kwargs["expected_preference_version_id"])
            if len(calls) == 2:
                raise RuntimeError("provider failed")
            return next(generated)

        monkeypatch.setattr("backend.app.recommendations.generate_recommendation", generate)
        try:
            assert refill_recommendation_queue(
                conn, Settings(_env_file=None, OPENROUTER_API_KEY="test"), user_id, retry_minutes=60,
            ) == 1
            rows = conn.execute(
                """SELECT slot, status, recommendation_id, retry_after, last_error
                   FROM telegram_recommendation_queue WHERE user_id = %s ORDER BY slot""",
                (user_id,),
            ).fetchall()
            assert rows[0]["status"] == "ready"
            assert rows[0]["recommendation_id"] == recommendation_ids[0]
            assert rows[1]["status"] == "pending"
            assert rows[1]["retry_after"] is not None
            assert rows[1]["last_error"] == "RuntimeError"
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id = %s", (user_id,))
            conn.commit()


def test_refill_adopts_committed_generation_after_bind_is_fenced(monkeypatch):
    database_url = _database_url()
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        user_id, profile_id, recommendation_ids = _seed_user(conn)
        lost_id = recommendation_ids[0]
        video_id = conn.execute(
            "SELECT video_id FROM recommendations WHERE id = %s", (lost_id,),
        ).fetchone()["video_id"]
        ensure_recommendation_queue(conn, user_id)
        conn.execute(
            """UPDATE telegram_recommendation_queue SET recommendation_id=%s,status='ready'
               WHERE user_id=%s AND slot=2""",
            (recommendation_ids[1], user_id),
        )
        conn.execute("DELETE FROM recommendations WHERE id=%s", (lost_id,))
        conn.commit()
        calls = []

        def generate(*args, **kwargs):
            calls.append(1)
            with psycopg.connect(database_url, row_factory=dict_row) as generated:
                generated.execute(
                    """INSERT INTO recommendations
                       (id,user_id,video_id,preference_version_id,rationale,evidence)
                       VALUES (%s,%s,%s,%s,'Recovered fit.','{\"reranker_fallback\": false}')""",
                    (lost_id, user_id, video_id, profile_id),
                )
                generated.execute(
                    """UPDATE telegram_recommendation_queue
                       SET generation_token=gen_random_uuid(),lease_expires_at=NOW()-INTERVAL '1 second'
                       WHERE user_id=%s AND slot=1""",
                    (user_id,),
                )
                generated.commit()
            return lost_id

        monkeypatch.setattr("backend.app.recommendations.generate_recommendation", generate)
        try:
            assert refill_recommendation_queue(
                conn, Settings(_env_file=None, OPENROUTER_API_KEY="test"), user_id, retry_minutes=60,
            ) == 1
            assert calls == [1]
            row = conn.execute(
                """SELECT status,recommendation_id FROM telegram_recommendation_queue
                   WHERE user_id=%s AND slot=1""",
                (user_id,),
            ).fetchone()
            assert row == {"status": "ready", "recommendation_id": lost_id}
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_scheduled_delivery_refills_beyond_two_item_instant_queue(monkeypatch):
    database_url = _database_url()
    with psycopg.connect(database_url, row_factory=dict_row) as setup:
        user_id, _, recommendation_ids = _seed_user(setup, recommendation_count=3)
        setup.execute(
            """UPDATE app_users SET timezone='UTC',cadence_days=ARRAY[0,1,2,3,4,5,6]::smallint[],
                   delivery_hour=0,recommendation_count=3,last_delivery_attempt_at=NULL,
                   onboarding_completed_at=NOW()
               WHERE id=%s""",
            (user_id,),
        )
        ensure_recommendation_queue(setup, user_id)
        for slot, recommendation_id in enumerate(recommendation_ids[:2], 1):
            setup.execute(
                """UPDATE telegram_recommendation_queue SET recommendation_id=%s,status='ready'
                   WHERE user_id=%s AND slot=%s""",
                (recommendation_id, user_id, slot),
            )
        setup.commit()

    class Pool:
        @contextmanager
        def connection(self):
            with psycopg.connect(database_url, row_factory=dict_row) as connection:
                yield connection

    sent = []
    settings = Settings(
        _env_file=None,
        DATABASE_URL=database_url,
        OPENROUTER_API_KEY="test",
        TELEGRAM_PRODUCTION_BOT_TOKEN="test",
    )
    monkeypatch.setattr("backend.worker.main.get_settings", lambda: settings)
    monkeypatch.setattr(
        "backend.worker.main.TelegramBot",
        lambda _: SimpleNamespace(
            send_recommendation=lambda connection, recommendation_id, *args: sent.append(recommendation_id),
        ),
    )
    try:
        from backend.worker.main import run_delivery_pass

        run_delivery_pass(Pool())
        assert sent == recommendation_ids
        with psycopg.connect(database_url, row_factory=dict_row) as check:
            delivered = check.execute(
                "SELECT COUNT(*) AS count FROM recommendations WHERE user_id=%s AND delivered_at IS NOT NULL",
                (user_id,),
            ).fetchone()["count"]
            assert delivered == 3
    finally:
        with psycopg.connect(database_url, row_factory=dict_row) as cleanup:
            cleanup.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            cleanup.commit()


def test_scheduled_delivery_clears_attempt_when_another_refill_holds_lease(monkeypatch):
    database_url = _database_url()
    with psycopg.connect(database_url, row_factory=dict_row) as setup:
        user_id, _, recommendation_ids = _seed_user(setup, recommendation_count=1)
        setup.execute(
            """UPDATE app_users SET timezone='UTC',cadence_days=ARRAY[0,1,2,3,4,5,6]::smallint[],
                   delivery_hour=0,recommendation_count=2,last_delivery_attempt_at=NULL,
                   onboarding_completed_at=NOW()
               WHERE id=%s""",
            (user_id,),
        )
        ensure_recommendation_queue(setup, user_id)
        setup.execute(
            """UPDATE telegram_recommendation_queue SET recommendation_id=%s,status='ready'
               WHERE user_id=%s AND slot=1""",
            (recommendation_ids[0], user_id),
        )
        setup.execute(
            """UPDATE telegram_recommendation_queue
               SET status='generating',generation_token=gen_random_uuid(),
                   lease_expires_at=NOW()+INTERVAL '5 minutes'
               WHERE user_id=%s AND slot=2""",
            (user_id,),
        )
        setup.commit()

    class Pool:
        @contextmanager
        def connection(self):
            with psycopg.connect(database_url, row_factory=dict_row) as connection:
                yield connection

    sent = []
    settings = Settings(
        _env_file=None, DATABASE_URL=database_url, OPENROUTER_API_KEY="test",
        TELEGRAM_PRODUCTION_BOT_TOKEN="test",
    )
    monkeypatch.setattr("backend.worker.main.get_settings", lambda: settings)
    monkeypatch.setattr(
        "backend.worker.main.TelegramBot",
        lambda _: SimpleNamespace(
            send_recommendation=lambda connection, recommendation_id, *args: sent.append(recommendation_id),
        ),
    )
    try:
        from backend.worker.main import run_delivery_pass

        run_delivery_pass(Pool())
        assert sent == recommendation_ids
        with psycopg.connect(database_url, row_factory=dict_row) as check:
            row = check.execute(
                "SELECT delivery_status,last_delivery_attempt_at FROM app_users WHERE id=%s",
                (user_id,),
            ).fetchone()
            assert row == {"delivery_status": "waiting", "last_delivery_attempt_at": None}
    finally:
        with psycopg.connect(database_url, row_factory=dict_row) as cleanup:
            cleanup.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            cleanup.commit()
