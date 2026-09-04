from datetime import UTC, datetime, timedelta

from backend.worker.main import delivery_is_due, ingestion_is_due


def test_delivery_respects_local_schedule_and_once_per_day() -> None:
    user = {"timezone": "America/Los_Angeles", "cadence_days": [3], "delivery_hour": 9}
    now = datetime(2026, 9, 2, 17, 0, tzinfo=UTC)
    assert delivery_is_due(user, None, now)
    assert not delivery_is_due(user, now - timedelta(hours=1), now)


class IngestionRunConnection:
    def __init__(self, row):
        self.row = row

    def execute(self, query):
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
