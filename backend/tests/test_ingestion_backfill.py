import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app.ingestion import _mark_channel_sync_started, ingest_tracked_channels
from backend.app.youtube import ChannelDetails, UploadPage, YouTubeVideo


class FakeEmbedder:
    model_name = "semantic-test"
    model_revision = "revision-test"
    dimensions = 384

    def embed_documents(self, texts):
        return [[1.0] + [0.0] * 383 for _ in texts]


def _video(video_id: str, channel_name: str, published_at: datetime) -> YouTubeVideo:
    return YouTubeVideo(
        youtube_video_id=video_id,
        channel_name=channel_name,
        title=f"Video {video_id}",
        speaker=None,
        youtube_url=f"https://www.youtube.com/watch?v={video_id}",
        thumbnail_url=None,
        description="Test ingestion video",
        published_at=published_at,
        duration_seconds=60,
        view_count=100,
    )


class TwoPhaseYouTube:
    def __init__(self, now: datetime):
        self.now = now
        self.calls: list[tuple[str, str | None, int]] = []

    def resolve_channel(self, url: str, known_id: str | None = None) -> ChannelDetails:
        slug = url.rsplit("/", 1)[-1].lstrip("@")
        return ChannelDetails(
            youtube_channel_id=f"yt-{slug}",
            name=f"Channel {slug}",
            uploads_playlist_id=f"uploads-{slug}",
        )

    def list_upload_page(
        self,
        playlist_id: str,
        page_token: str | None = None,
        max_results: int = 50,
    ) -> UploadPage:
        self.calls.append((playlist_id, page_token, max_results))
        slug = playlist_id.removeprefix("uploads-")
        if page_token is None:
            return UploadPage(
                [_video(f"test-recent-{slug}", f"Channel {slug}", self.now - timedelta(days=1))],
                f"backfill-{slug}",
            )
        return UploadPage(
            [_video(f"test-old-{slug}", f"Channel {slug}", self.now - timedelta(days=30))],
            None,
        )


class FailOnceYouTube(TwoPhaseYouTube):
    def __init__(self, now: datetime):
        super().__init__(now)
        self.resolve_calls: list[str] = []
        self.failed_once = False

    def resolve_channel(self, url: str, known_id: str | None = None) -> ChannelDetails:
        self.resolve_calls.append(url)
        if "retry" in url and not self.failed_once:
            self.failed_once = True
            raise RuntimeError("temporary recent-scan failure")
        return super().resolve_channel(url, known_id)


class FailingBackfillYouTube(TwoPhaseYouTube):
    def list_upload_page(
        self,
        playlist_id: str,
        page_token: str | None = None,
        max_results: int = 50,
    ) -> UploadPage:
        if page_token is not None:
            self.calls.append((playlist_id, page_token, max_results))
            raise RuntimeError("temporary YouTube failure")
        return super().list_upload_page(playlist_id, page_token, max_results)


class EmptyUpdateResult:
    def fetchone(self):
        return None


class ConcurrentStopConnection:
    def __init__(self):
        self.committed = False

    def execute(self, query, params):
        assert "WHERE id = %s AND is_active = TRUE" in str(query)
        assert "RETURNING id" in str(query)
        return EmptyUpdateResult()

    def commit(self):
        self.committed = True


def test_sync_start_guard_skips_a_channel_stopped_after_initial_selection() -> None:
    conn = ConcurrentStopConnection()
    assert _mark_channel_sync_started(conn, uuid4()) is False
    assert conn.committed is True


@pytest.fixture
def database_connection():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        yield conn


def test_retry_pass_scans_only_the_failed_channel(database_connection) -> None:
    conn = database_connection
    now = datetime.now(UTC)
    healthy_id, retry_id = uuid4(), uuid4()
    channel_ids = [healthy_id, retry_id]
    original_active = conn.execute("SELECT id, is_active FROM tracked_channels").fetchall()
    conn.execute("UPDATE tracked_channels SET is_active = FALSE")
    for channel_id, slug in ((healthy_id, "healthy"), (retry_id, "retry")):
        conn.execute(
            """
            INSERT INTO tracked_channels (
                id, user_id, name, url, is_active, max_video_age_days
            ) VALUES (%s, '00000000-0000-0000-0000-000000000001', %s, %s, TRUE, 365)
            """,
            (channel_id, f"Test {slug}", f"https://www.youtube.com/@issue7-{slug}"),
        )
    conn.commit()
    youtube = FailOnceYouTube(now)
    try:
        first = ingest_tracked_channels(
            conn,
            youtube,
            page_limit=1,
            backfill_limit=5,
            embedder=FakeEmbedder(),
            sync_interval_hours=6,
            retry_minutes=30,
        )
        assert first.channels_scanned == 2
        assert first.channels_failed == 1
        conn.execute(
            """
            UPDATE tracked_channels
            SET last_sync_completed_at = NOW() - INTERVAL '31 minutes'
            WHERE id = %s
            """,
            (retry_id,),
        )
        conn.commit()
        youtube.resolve_calls.clear()

        second = ingest_tracked_channels(
            conn,
            youtube,
            page_limit=1,
            backfill_limit=5,
            embedder=FakeEmbedder(),
            sync_interval_hours=6,
            retry_minutes=30,
        )
        assert second.channels_scanned == 1
        assert second.channels_failed == 0
        assert youtube.resolve_calls == ["https://www.youtube.com/@issue7-retry"]
    finally:
        conn.execute("DELETE FROM videos WHERE tracked_channel_id = ANY(%s)", (channel_ids,))
        conn.execute("DELETE FROM tracked_channels WHERE id = ANY(%s)", (channel_ids,))
        for row in original_active:
            conn.execute(
                "UPDATE tracked_channels SET is_active = %s WHERE id = %s",
                (row["is_active"], row["id"]),
            )
        conn.commit()


def test_ingestion_checks_all_recent_uploads_before_bounded_backfill(database_connection) -> None:
    conn = database_connection
    now = datetime.now(UTC)
    channel_ids = [uuid4(), uuid4(), uuid4()]
    original_active = conn.execute("SELECT id, is_active FROM tracked_channels").fetchall()
    conn.execute("UPDATE tracked_channels SET is_active = FALSE")
    for index, channel_id in enumerate(channel_ids):
        conn.execute(
            """
            INSERT INTO tracked_channels (
                id, user_id, name, url, is_active, max_video_age_days
            ) VALUES (%s, '00000000-0000-0000-0000-000000000001', %s, %s, %s, 365)
            """,
            (channel_id, f"Test channel {index}", f"https://www.youtube.com/@issue7-{index}", index < 2),
        )
    preserved_video_id = uuid4()
    conn.execute(
        """
        INSERT INTO videos (
            id, youtube_video_id, tracked_channel_id, channel_name, title, youtube_url
        ) VALUES (%s, 'test-preserved-inactive', %s, 'Inactive', 'Preserved',
                  'https://www.youtube.com/watch?v=test-preserved-inactive')
        """,
        (preserved_video_id, channel_ids[2]),
    )
    conn.commit()
    youtube = TwoPhaseYouTube(now)
    try:
        summary = ingest_tracked_channels(conn, youtube, page_limit=1, backfill_limit=5, embedder=FakeEmbedder())
        assert summary.channels_scanned == 2
        assert summary.channels_failed == 0
        assert [call[1] for call in youtube.calls] == [None, None, "backfill-issue7-0", "backfill-issue7-1"]
        assert [call[2] for call in youtube.calls[-2:]] == [5, 5]
        rows = conn.execute(
            """
            SELECT id, sync_status, backfill_page_token, backfill_completed_at
            FROM tracked_channels WHERE id = ANY(%s) ORDER BY url
            """,
            (channel_ids[:2],),
        ).fetchall()
        assert all(row["sync_status"] == "completed" for row in rows)
        assert all(row["backfill_page_token"] is None for row in rows)
        assert all(row["backfill_completed_at"] is not None for row in rows)
        linked_count = conn.execute(
            "SELECT COUNT(*) AS count FROM videos WHERE tracked_channel_id = ANY(%s)",
            (channel_ids[:2],),
        ).fetchone()["count"]
        assert linked_count == 4
        assert conn.execute(
            "SELECT 1 FROM videos WHERE id = %s", (preserved_video_id,),
        ).fetchone()
    finally:
        conn.execute("DELETE FROM videos WHERE tracked_channel_id = ANY(%s)", (channel_ids,))
        conn.execute("DELETE FROM tracked_channels WHERE id = ANY(%s)", (channel_ids,))
        for row in original_active:
            conn.execute(
                "UPDATE tracked_channels SET is_active = %s WHERE id = %s",
                (row["is_active"], row["id"]),
            )
        conn.commit()


def test_backfill_failure_keeps_cursor_and_surfaces_channel_error(database_connection) -> None:
    conn = database_connection
    now = datetime.now(UTC)
    channel_id = uuid4()
    original_active = conn.execute("SELECT id, is_active FROM tracked_channels").fetchall()
    conn.execute("UPDATE tracked_channels SET is_active = FALSE")
    conn.execute(
        """
        INSERT INTO tracked_channels (
            id, user_id, name, url, is_active, max_video_age_days, backfill_page_token
        ) VALUES (%s, '00000000-0000-0000-0000-000000000001', 'Failure test',
                  'https://www.youtube.com/@issue7-failure', TRUE, 365, 'persisted-cursor')
        """,
        (channel_id,),
    )
    conn.commit()
    youtube = FailingBackfillYouTube(now)
    try:
        summary = ingest_tracked_channels(conn, youtube, page_limit=1, backfill_limit=7, embedder=FakeEmbedder())
        assert summary.channels_failed == 1
        row = conn.execute(
            """
            SELECT sync_status, sync_error, backfill_page_token
            FROM tracked_channels WHERE id = %s
            """,
            (channel_id,),
        ).fetchone()
        assert row["sync_status"] == "failed"
        assert "temporary YouTube failure" in row["sync_error"]
        assert row["backfill_page_token"] == "persisted-cursor"
        assert youtube.calls[-1] == ("uploads-issue7-failure", "persisted-cursor", 7)
    finally:
        conn.execute("DELETE FROM videos WHERE tracked_channel_id = %s", (channel_id,))
        conn.execute("DELETE FROM tracked_channels WHERE id = %s", (channel_id,))
        for row in original_active:
            conn.execute(
                "UPDATE tracked_channels SET is_active = %s WHERE id = %s",
                (row["is_active"], row["id"]),
            )
        conn.commit()
