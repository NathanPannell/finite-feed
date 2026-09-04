from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from backend.app.main import update_delivery, update_preference_memory
from backend.app.schemas import DeliveryUpdate, PreferenceMemoryUpdate


class Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class ProfileConnection:
    def __init__(self):
        self.profile = {
            "version": 4,
            "preference_statement": "Current server memory",
            "rendered_markdown": "# Current server memory",
            "updated_at": datetime(2026, 9, 4, tzinfo=timezone.utc),
            "timezone": "Pacific/Auckland",
            "cadence_days": [1, 4],
            "delivery_hour": 17,
            "recommendation_count": 1,
        }
        self.queries: list[str] = []
        self.preference_inserts = 0
        self.revision_events = 0
        self.commits = 0

    def execute(self, query, params=None):
        sql = str(query)
        self.queries.append(sql)
        if "SELECT id FROM app_users" in sql and "FOR UPDATE" in sql:
            return Result({"id": "owner"})
        if "SELECT p.version" in sql:
            return Result(dict(self.profile))
        if "UPDATE app_users SET cadence_days" in sql:
            self.profile["cadence_days"] = params[0]
            self.profile["recommendation_count"] = params[1]
            return Result()
        if "INSERT INTO preference_versions" in sql:
            self.preference_inserts += 1
            self.profile.update(
                version=params[2],
                preference_statement=params[3],
                rendered_markdown=params[4],
            )
            return Result()
        if "INSERT INTO interaction_events" in sql:
            self.revision_events += 1
            return Result()
        raise AssertionError(sql)

    def commit(self):
        self.commits += 1


def test_delivery_update_changes_only_delivery_fields_without_revision() -> None:
    conn = ProfileConnection()
    before = dict(conn.profile)

    saved = update_delivery(
        DeliveryUpdate(cadence_days=[5, 2, 5], recommendation_count=3),
        conn,
    )

    assert saved["cadence_days"] == [2, 5]
    assert saved["recommendation_count"] == 3
    for field in ("preference_statement", "version", "rendered_markdown", "timezone", "delivery_hour"):
        assert saved[field] == before[field]
    assert conn.preference_inserts == 0
    assert conn.revision_events == 0
    assert conn.commits == 1
    delivery_sql = next(query for query in conn.queries if "UPDATE app_users" in query)
    assert "timezone" not in delivery_sql
    assert "delivery_hour" not in delivery_sql


def test_memory_update_locks_and_rejects_a_stale_version() -> None:
    conn = ProfileConnection()

    with pytest.raises(HTTPException) as raised:
        update_preference_memory(
            PreferenceMemoryUpdate(preference_statement="Stale edit", expected_version=3),
            conn,
        )

    assert raised.value.status_code == 409
    assert "FOR UPDATE" in conn.queries[0]
    assert conn.preference_inserts == 0
    assert conn.revision_events == 0
    assert conn.commits == 0


def test_memory_update_creates_one_revision_without_rewriting_delivery() -> None:
    conn = ProfileConnection()
    delivery_before = {field: conn.profile[field] for field in (
        "timezone", "cadence_days", "delivery_hour", "recommendation_count"
    )}

    saved = update_preference_memory(
        PreferenceMemoryUpdate(preference_statement="  Sharper server memory  ", expected_version=4),
        conn,
    )

    assert "FOR UPDATE" in conn.queries[0]
    assert saved["preference_statement"] == "Sharper server memory"
    assert saved["version"] == 5
    assert {field: saved[field] for field in delivery_before} == delivery_before
    assert conn.preference_inserts == 1
    assert conn.revision_events == 1
    assert conn.commits == 1
