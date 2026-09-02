from datetime import UTC, datetime, timedelta

from backend.worker.main import delivery_is_due


def test_delivery_respects_local_schedule_and_once_per_day() -> None:
    user = {"timezone": "America/Los_Angeles", "cadence_days": [3], "delivery_hour": 9}
    now = datetime(2026, 9, 2, 17, 0, tzinfo=UTC)
    assert delivery_is_due(user, None, now)
    assert not delivery_is_due(user, now - timedelta(hours=1), now)
