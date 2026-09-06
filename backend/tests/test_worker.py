from datetime import UTC, datetime, timedelta

from backend.worker.main import delivery_is_due, ingestion_is_due


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
