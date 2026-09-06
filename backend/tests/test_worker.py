from datetime import UTC, datetime, timedelta

from backend.worker.main import delivery_is_due, ingestion_is_due


def test_scheduled_delivery_selects_only_completed_onboarding_accounts() -> None:
    import os
    from uuid import uuid4

    import psycopg
    import pytest
    from psycopg.rows import dict_row

    from backend.worker.main import scheduled_delivery_users

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")
    incomplete, complete = uuid4(), uuid4()
    incomplete_chat = incomplete.int % 1_000_000_000 + 7_000_000_000
    complete_chat = complete.int % 1_000_000_000 + 8_000_000_000
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        try:
            conn.execute(
                "INSERT INTO app_users(id,display_name,auth_subject,telegram_user_id,onboarding_completed_at) "
                "VALUES (%s,'Incomplete',%s,%s,NULL),(%s,'Complete',%s,%s,NOW())",
                (incomplete, f"incomplete-{incomplete}", incomplete_chat,
                 complete, f"complete-{complete}", complete_chat),
            )
            conn.commit()
            selected = {row["id"] for row in scheduled_delivery_users(conn)}
            assert incomplete not in selected
            assert complete in selected
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=ANY(%s)", ([incomplete, complete],))
            conn.commit()


def test_delivery_respects_local_schedule_and_once_per_day() -> None:
    user = {"timezone": "America/Los_Angeles", "cadence_days": [3], "delivery_hour": 9}
    now = datetime(2026, 9, 2, 17, 0, tzinfo=UTC)
    assert delivery_is_due(user, None, now)
    assert not delivery_is_due(user, now - timedelta(hours=1), now)


class IngestionRunConnection:
    def __init__(self, row, first_sync=False):
        self.row = row
        self.first_sync = first_sync

    def execute(self, query):
        if "FROM tracked_channels" in query:
            assert "is_active AND last_sync_started_at IS NULL" in query
            return type("Result", (), {"fetchone": lambda _self: {"id": "new"} if self.first_sync else None})()
        assert "ORDER BY started_at DESC" in str(query)
        return type("Result", (), {"fetchone": lambda _self: self.row})()


def test_failed_ingestion_waits_for_retry_cooldown() -> None:
    now = datetime(2026, 9, 4, 8, 0, tzinfo=UTC)
    recent_failure = {
        "status": "failed",
        "started_at": now - timedelta(minutes=12),
        "completed_at": now - timedelta(minutes=10),
    }
    assert not ingestion_is_due(IngestionRunConnection(recent_failure), 6, 30, now)
    recent_failure["completed_at"] = now - timedelta(minutes=31)
    assert ingestion_is_due(IngestionRunConnection(recent_failure), 6, 30, now)


def test_successful_ingestion_keeps_the_normal_interval() -> None:
    now = datetime(2026, 9, 4, 8, 0, tzinfo=UTC)
    completed = {
        "status": "completed",
        "started_at": now - timedelta(hours=7),
        "completed_at": now - timedelta(hours=5),
    }
    assert not ingestion_is_due(IngestionRunConnection(completed), 6, 30, now)
    completed["completed_at"] = now - timedelta(hours=7)
    assert ingestion_is_due(IngestionRunConnection(completed), 6, 30, now)


def test_new_active_source_does_not_wait_for_previous_completed_batch() -> None:
    now = datetime(2026, 9, 4, 8, 0, tzinfo=UTC)
    completed = {"status": "completed", "started_at": now, "completed_at": now}
    assert ingestion_is_due(IngestionRunConnection(completed, first_sync=True), 6, 30, now)
    # Once attempted, its normal per-source retry/interval applies again.
    assert not ingestion_is_due(IngestionRunConnection(completed), 6, 30, now)
