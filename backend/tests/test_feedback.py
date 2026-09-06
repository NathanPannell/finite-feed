from uuid import UUID

from backend.app.main import record_feedback
USER_ID = UUID("00000000-0000-0000-0000-000000000001")
from backend.app.schemas import FeedbackCreate


class Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FeedbackConnection:
    def __init__(self, recommendation_id):
        self.recommendation_id = recommendation_id
        self.committed = False

    def execute(self, query, params=None):
        sql = " ".join(str(query).split())
        if sql.startswith("UPDATE recommendations"):
            return Result({"id": self.recommendation_id})
        if sql.startswith("INSERT INTO interaction_events"):
            return Result()
        assert "WHERE r.user_id = %s AND r.id = %s" in sql
        assert params == (USER_ID, self.recommendation_id)
        return Result({"id": self.recommendation_id, "rating": "up"})

    def commit(self):
        self.committed = True

    def rollback(self):
        raise AssertionError("feedback update should not roll back")


def test_feedback_returns_the_requested_recommendation() -> None:
    recommendation_id = UUID("40000000-0000-4000-8000-000000000008")
    conn = FeedbackConnection(recommendation_id)
    row = record_feedback(recommendation_id, FeedbackCreate(rating="up"), USER_ID, conn)
    assert row["id"] == recommendation_id
    assert conn.committed is True
