from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
import backend.app.admin as admin_module
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app.admin import (
    ChannelCreate,
    ChannelPatch,
    VectorSearch,
    delivery_state,
    parse_channel_reference,
    patch_channel,
    resolve_admin_owner,
    router,
    upsert_admin_channel,
    vector_search,
)
from backend.app.admin_auth import require_admin
from backend.app.db import connection
from backend.app.settings import Settings

USER_ID = UUID("00000000-0000-0000-0000-000000000001")


class Result:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class ChannelConnection:
    def __init__(self, existing=None):
        self.existing = existing
        self.queries: list[str] = []
        self.audit_params = None
        self.committed = False

    def execute(self, query, params=None):
        sql = str(query)
        self.queries.append(sql)
        if "SELECT id FROM app_users" in sql:
            return Result({"id": USER_ID})
        if "SELECT * FROM tracked_channels" in sql:
            return Result(self.existing)
        if "UPDATE tracked_channels" in sql:
            return Result({**self.existing, "is_active": True, "max_video_age_days": params[0]})
        if "INSERT INTO tracked_channels" in sql:
            return Result({"id": params[0], "user_id": USER_ID, "is_active": True, "max_video_age_days": 7})
        if "INSERT INTO admin_audit_events" in sql:
            self.audit_params = params
            return Result()
        raise AssertionError(sql)

    def commit(self):
        self.committed = True


def channel_details() -> dict:
    return {
        "youtube_channel_id": "UC" + "a" * 22,
        "name": "Channel",
        "url": "https://www.youtube.com/channel/UC" + "a" * 22,
        "thumbnail_url": None,
        "description": "",
        "uploads_playlist_id": "UU" + "a" * 22,
        "subscriber_count": 100,
        "public_video_count": 20,
    }


def test_channel_url_parser_only_accepts_unambiguous_forms() -> None:
    assert parse_channel_reference("https://youtube.com/@FiniteFeed") == ("forHandle", "FiniteFeed")
    channel_id = "UC" + "a" * 22
    assert parse_channel_reference(f"https://www.youtube.com/channel/{channel_id}") == ("id", channel_id)
    with pytest.raises(ValueError, match="unambiguous"):
        parse_channel_reference("https://youtube.com/results?search_query=finite")


def test_max_age_is_bounded_and_patch_is_narrow() -> None:
    with pytest.raises(ValidationError):
        ChannelCreate(url="https://youtube.com/@FiniteFeed", user_id=USER_ID, max_video_age_days=366)
    with pytest.raises(ValidationError, match="exactly one"):
        ChannelPatch(is_active=True, max_video_age_days=30)
    assert ChannelCreate(url="https://youtube.com/@FiniteFeed", user_id=USER_ID).max_video_age_days == 7


class OwnersConnection:
    def __init__(self, owners):
        self.owners = owners

    def execute(self, query, _params=None):
        assert "FROM app_users" in str(query)
        return Result(rows=self.owners)


def test_omitted_owner_auto_selects_only_a_single_app_user() -> None:
    assert resolve_admin_owner(OwnersConnection([{"id": USER_ID}]), None) == USER_ID
    with pytest.raises(HTTPException) as error:
        resolve_admin_owner(OwnersConnection([{"id": USER_ID}, {"id": uuid4()}]), None)
    assert error.value.status_code == 409
    assert "Select an owner" in error.value.detail


def test_active_duplicate_is_rejected_by_canonical_channel_id() -> None:
    existing = {"id": uuid4(), "user_id": USER_ID, "is_active": True, "max_video_age_days": 7}
    conn = ChannelConnection(existing)
    with pytest.raises(HTTPException) as error:
        upsert_admin_channel(
            conn, user_id=USER_ID, details=channel_details(), max_video_age_days=7, actor="verified-subject",
        )
    assert error.value.status_code == 409



def test_cross_owner_duplicate_is_rejected_without_reassignment() -> None:
    existing = {
        "id": uuid4(),
        "user_id": uuid4(),
        "is_active": True,
        "max_video_age_days": 7,
    }
    conn = ChannelConnection(existing)
    with pytest.raises(HTTPException) as error:
        upsert_admin_channel(
            conn,
            user_id=USER_ID,
            details=channel_details(),
            max_video_age_days=7,
            actor="verified-subject",
        )
    assert error.value.status_code == 409
    assert "shared channel ownership is not supported" in error.value.detail
    assert not any(query.startswith("UPDATE tracked_channels") for query in conn.queries)


def test_inactive_duplicate_reactivates_same_record_and_audits() -> None:
    channel_id = uuid4()
    existing = {"id": channel_id, "user_id": USER_ID, "is_active": False, "max_video_age_days": 7}
    conn = ChannelConnection(existing)
    row, reactivated = upsert_admin_channel(
        conn, user_id=USER_ID, details=channel_details(), max_video_age_days=30, actor="verified-subject",
    )
    assert reactivated is True
    assert row["id"] == channel_id
    assert conn.audit_params[1:5] == ("reactivate", channel_id, USER_ID, "verified-subject")
    assert conn.committed is True
    assert not any("DELETE" in query for query in conn.queries)


class PatchConnection:
    def __init__(self, channel_id):
        self.channel = {
            "id": channel_id, "user_id": USER_ID, "is_active": True, "max_video_age_days": 7,
        }
        self.queries = []
        self.audit_params = None

    def execute(self, query, params=None):
        sql = str(query)
        self.queries.append(sql)
        if sql.startswith("SELECT"):
            return Result(dict(self.channel))
        if sql.startswith("UPDATE"):
            self.channel["is_active"] = params[0]
            return Result(dict(self.channel))
        if "INSERT INTO admin_audit_events" in sql:
            self.audit_params = params
            return Result()
        raise AssertionError(sql)

    def commit(self):
        pass

    def rollback(self):
        pass


def test_soft_stop_is_audited_without_delete() -> None:
    channel_id = uuid4()
    conn = PatchConnection(channel_id)
    row = patch_channel(channel_id, ChannelPatch(is_active=False), {"sub": "verified-subject"}, conn)
    assert row["is_active"] is False
    assert conn.audit_params[1] == "stop"
    assert not any("DELETE" in query for query in conn.queries)


class LegacyChannelConnection:
    def __init__(self):
        self.channel_id = uuid4()
        self.active = True
        self.queries = []

    def execute(self, query, _params=None):
        sql = str(query)
        self.queries.append(sql)
        if "UPDATE tracked_channels SET is_active = FALSE" in sql:
            self.active = False
            return Result({"url": "https://youtube.com/@FiniteFeed"})
        if "INSERT INTO tracked_channels" in sql:
            if self.active:
                return Result(None)
            self.active = True
            return Result({
                "id": self.channel_id, "name": "Finite Feed", "url": "https://youtube.com/@FiniteFeed",
                "is_default": False, "created_at": datetime.now(timezone.utc),
            })
        if "INSERT INTO interaction_events" in sql:
            return Result()
        if "FROM tracked_channels WHERE" in sql:
            rows = [{
                "id": self.channel_id, "name": "Finite Feed", "url": "https://youtube.com/@FiniteFeed",
                "is_default": False, "created_at": datetime.now(timezone.utc),
            }] if self.active else []
            return Result(rows=rows)
        raise AssertionError(sql)

    def commit(self):
        pass

    def rollback(self):
        pass


def test_public_stop_then_readd_restores_same_channel_without_delete() -> None:
    from backend.app.main import add_channel, list_channels, remove_channel
    from backend.app.schemas import ChannelCreate as PublicChannelCreate

    conn = LegacyChannelConnection()
    remove_channel(conn.channel_id, conn)
    assert list_channels(conn) == []
    restored = add_channel(
        PublicChannelCreate(name="Finite Feed", url="https://youtube.com/@FiniteFeed"), conn,
    )
    assert restored["id"] == conn.channel_id
    assert list_channels(conn)[0]["id"] == conn.channel_id
    assert not any("DELETE" in query for query in conn.queries)


def test_queued_and_delivered_are_derived_only_from_delivered_at() -> None:
    assert delivery_state(None) == "queued"
    assert delivery_state(datetime.now(timezone.utc)) == "delivered"


class FakeEmbedder:
    model_name = "semantic-test"
    model_revision = "revision-test"
    dimensions = 384

    def embed_queries(self, texts):
        assert texts == ["football psychology"]
        return [[1.0] + [0.0] * 383]


class VectorConnection:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def execute(self, query, params=None):
        sql = " ".join(str(query).split())
        self.queries.append((sql, params))
        if sql.startswith("SET LOCAL"):
            return Result(rows=[])
        assert "semantic_embedding <=>" in sql
        assert params[2:5] == ("semantic-test", "revision-test", 384)
        assert params[5] == "description-v3"
        assert params[-1] == 20
        return Result(rows=self.rows)


def test_vector_search_uses_pgvector_and_omits_vectors(monkeypatch) -> None:
    video_id = uuid4()
    rows = [{
        "id": video_id, "youtube_video_id": "video", "tracked_channel_id": None,
        "channel_name": "Channel", "title": "Football psychology", "speaker": None,
        "youtube_url": "https://youtu.be/x", "thumbnail_url": None,
        "published_at": None, "ingested_at": None, "duration_seconds": 60,
        "view_count": 1, "embedding_model": "semantic-test",
        "embedding_revision": "revision-test", "embedding_dimensions": 384,
        "similarity": 0.91, "similarity_score": 0.91,
    }]
    conn = VectorConnection(rows)
    monkeypatch.setattr(admin_module, "configured_embedder", lambda _settings: FakeEmbedder())
    result = vector_search(VectorSearch(phrase="football psychology"), conn, Settings(_env_file=None))
    assert [item["id"] for item in result["items"]] == [video_id]
    assert result["revision"] == "revision-test"
    assert all("embedding" not in item for item in result["items"])
    assert [sql for sql, _ in conn.queries if sql.startswith("SET LOCAL")] == [
        "SET LOCAL hnsw.iterative_scan = strict_order",
        "SET LOCAL hnsw.ef_search = 100",
    ]


def test_vector_search_rejects_unknown_model(monkeypatch) -> None:
    monkeypatch.setattr(admin_module, "configured_embedder", lambda _settings: FakeEmbedder())
    with pytest.raises(HTTPException) as error:
        vector_search(
            VectorSearch(phrase="football psychology", model="unknown"),
            VectorConnection([]),
            Settings(_env_file=None),
        )
    assert error.value.status_code == 422


class EmptyConnection:
    def __init__(self):
        self.calls = []

    def execute(self, query, _params=None):
        self.calls.append((str(query), _params))
        if "COUNT(*)" in str(query):
            return Result({"count": 0})
        return Result(rows=[])


def test_list_query_parameters_are_allowlisted_and_bounded() -> None:
    app = FastAPI()
    app.include_router(router)
    conn = EmptyConnection()
    app.dependency_overrides[require_admin] = lambda: {"sub": "test"}
    app.dependency_overrides[connection] = lambda: conn
    client = TestClient(app)
    assert client.get("/api/admin/videos?sort=drop_table").status_code == 422
    assert client.get("/api/admin/recommendations?page_size=101").status_code == 422
    assert client.get("/api/admin/channels?sort=last_ingestion_at_desc").status_code == 200
    assert client.get("/api/admin/videos?sort=published_at&direction=desc&published_from=2026-09-01&ingested_from=2026-09-02").status_code == 200
    video_sql, video_params = conn.calls[-1]
    assert "v.published_at >= %s" in video_sql and "v.ingested_at >= %s" in video_sql
    assert [value.date().isoformat() for value in video_params[:2]] == ["2026-09-01", "2026-09-02"]
    assert client.get("/api/admin/recommendations?sort=created_at&direction=desc&delivery=queued").status_code == 200
    recommendation_sql, _ = conn.calls[-1]
    assert "r.delivered_at IS NULL" in recommendation_sql
