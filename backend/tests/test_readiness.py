from datetime import UTC, datetime
from backend.app.deployment import deployed_source_commit
from backend.app.main import worker_readiness


class Result:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, row):
        self.row = row

    def execute(self, query):
        assert "FROM worker_heartbeat" in query
        return Result(self.row)


def test_worker_readiness_reports_deployed_commit_and_timestamp() -> None:
    timestamp = datetime(2026, 9, 6, 16, 30, tzinfo=UTC)
    assert worker_readiness(
        Connection({"status": "healthy", "commit_sha": "abc123", "last_seen_at": timestamp})
    ) == {
        "status": "healthy",
        "commit": "abc123",
        "last_seen_at": "2026-09-06T16:30:00+00:00",
    }


def test_worker_readiness_is_absent_before_first_heartbeat() -> None:
    assert worker_readiness(Connection(None)) is None


class SourceStamp:
    def __init__(self, exists: bool, text: str = ""):
        self.exists = exists
        self.text = text

    def is_file(self):
        return self.exists

    def read_text(self, *, encoding):
        assert encoding == "utf-8"
        return self.text


def test_deployed_source_commit_uses_baked_railway_stamp() -> None:
    assert deployed_source_commit("configured-sha", SourceStamp(True, "source-sha:worker\n")) == "source-sha"


def test_deployed_source_commit_falls_back_outside_railway() -> None:
    assert deployed_source_commit("configured-sha", SourceStamp(False)) == "configured-sha"
