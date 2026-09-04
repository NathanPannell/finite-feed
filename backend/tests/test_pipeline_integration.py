import os
from datetime import UTC, datetime
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app.embedding_backfill import backfill_embeddings
from backend.app.ingestion import ingest_tracked_channels
from backend.app.recommendations import (
    _nearest_rows,
    generate_recommendation,
    get_or_create_pending_recommendation,
    lock_recommendation_for_delivery,
    mark_recommendation_delivered,
)
from backend.app.settings import Settings
from backend.app.youtube import ChannelDetails, YouTubeVideo
from backend.worker.main import claim_delivery_attempt

USER_ID = UUID("00000000-0000-0000-0000-000000000001")


class FakeYouTube:
    def __init__(self) -> None:
        self.relevant_description = "How pressure, motivation, and team culture shape elite football."

    def resolve_channel(self, url: str, known_id: str | None = None) -> ChannelDetails:
        slug = "tedx" if "tedx" in url.lower() else "ted"
        name = "TEDx" if slug == "tedx" else "TED"
        return ChannelDetails(slug, name, f"uploads-{slug}")

    def list_uploads(self, playlist_id: str, page_limit: int = 2) -> list[YouTubeVideo]:
        relevant = playlist_id.endswith("ted")
        video_id = "test-football-psychology" if relevant else "test-pottery"
        title = "The psychology of football decisions | Casey Coach | TED" if relevant else "The chemistry of pottery | Pat Potter | TEDx"
        description = self.relevant_description if relevant else "A tour of ceramic glazes and kilns."
        return [YouTubeVideo(
            video_id, "TED" if relevant else "TEDx", title, "Casey Coach" if relevant else "Pat Potter",
            f"https://www.youtube.com/watch?v={video_id}", None, description,
            datetime(2026, 9, 1, tzinfo=UTC), 900, 1000,
        )]


class FakeEmbedder:
    model_name = "test-semantic-embedder"
    model_revision = "test-revision-1"
    dimensions = 384

    @staticmethod
    def _vector(text: str) -> list[float]:
        related = any(word in text.lower() for word in ("football", "psychology", "coaching", "motivation"))
        return ([1.0, 0.0] if related else [0.0, 1.0]) + [0.0] * 382

    def embed_documents(self, texts) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    def embed_queries(self, texts) -> list[list[float]]:
        return [self._vector(text) for text in texts]


def test_ingest_retrieve_and_persist_recommendation() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute("DELETE FROM recommendations")
        conn.execute("DELETE FROM videos WHERE youtube_video_id LIKE 'test-%'")
        conn.execute("UPDATE app_users SET last_delivery_attempt_at = NULL WHERE id = %s", (USER_ID,))
        conn.commit()
        youtube = FakeYouTube()
        embedder = FakeEmbedder()
        summary = ingest_tracked_channels(conn, youtube, page_limit=1, embedder=embedder)
        assert summary.channels_scanned == 2
        assert summary.videos_changed == 2
        unchanged = ingest_tracked_channels(conn, youtube, page_limit=1, embedder=embedder)
        assert unchanged.videos_changed == 0
        youtube.relevant_description += " Updated after a new coaching interview."
        refreshed = ingest_tracked_channels(conn, youtube, page_limit=1, embedder=embedder)
        assert refreshed.videos_changed == 1
        recommendation_id = generate_recommendation(
            conn, Settings(DATABASE_URL=database_url), USER_ID, embedder=embedder
        )
        row = conn.execute(
            "SELECT v.title, r.evidence FROM recommendations r JOIN videos v ON v.id = r.video_id WHERE r.id = %s",
            (recommendation_id,),
        ).fetchone()
        assert "football" in row["title"].lower()
        assert row["evidence"]["pipeline"] == "pgvector-cosine-openrouter-rerank-v2"
        assert row["evidence"]["embedding_revision"] == embedder.model_revision
        settings = Settings(DATABASE_URL=database_url)
        assert get_or_create_pending_recommendation(conn, settings, USER_ID) == recommendation_id
        with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
            get_or_create_pending_recommendation(conn, settings, USER_ID, require_model=True)
        assert lock_recommendation_for_delivery(conn, USER_ID, recommendation_id)
        mark_recommendation_delivered(conn, USER_ID, recommendation_id, scheduled=True)
        assert not lock_recommendation_for_delivery(conn, USER_ID, recommendation_id)
        mark_recommendation_delivered(conn, USER_ID, recommendation_id, scheduled=True)
        delivery = conn.execute(
            "SELECT COUNT(*) AS count FROM interaction_events WHERE recommendation_id = %s AND event_type = 'delivery'",
            (recommendation_id,),
        ).fetchone()
        assert delivery["count"] == 1
        now = datetime.now(UTC)
        assert claim_delivery_attempt(conn, USER_ID, now, retry_minutes=60)
        assert not claim_delivery_attempt(conn, USER_ID, now, retry_minutes=60)


def test_hnsw_iterative_scan_reaches_eligible_rows_after_filtered_decoys() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    embedder = FakeEmbedder()
    query = "[" + ",".join(["1", "0"] + ["0"] * 382) + "]"
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute("DELETE FROM recommendations")
        conn.execute("DELETE FROM videos")
        decoy_ids = []
        for index in range(60):
            video_id = uuid4()
            decoy_ids.append(video_id)
            fingerprint = f"decoy-{index}"
            conn.execute(
                """
                INSERT INTO videos (
                    id, youtube_video_id, channel_name, title, youtube_url, description,
                    published_at, content_fingerprint, semantic_embedding,
                    semantic_embedding_model, semantic_embedding_revision,
                    semantic_embedding_dimensions, semantic_embedding_fingerprint
                ) VALUES (%s, %s, 'TED', 'Filtered decoy', %s, '', NOW(), %s,
                          %s::vector, %s, %s, %s, %s)
                """,
                (
                    video_id, f"test-ann-decoy-{index}", f"https://youtu.be/decoy-{index}",
                    fingerprint, query, embedder.model_name, embedder.model_revision,
                    embedder.dimensions, fingerprint,
                ),
            )
            conn.execute(
                "INSERT INTO recommendations (id, user_id, video_id, rationale) VALUES (%s, %s, %s, 'sent')",
                (uuid4(), USER_ID, video_id),
            )
        eligible_id = uuid4()
        eligible_fingerprint = "eligible"
        eligible_vector = "[" + ",".join(["0.8", "0.6"] + ["0"] * 382) + "]"
        conn.execute(
            """
            INSERT INTO videos (
                id, youtube_video_id, channel_name, title, youtube_url, description,
                published_at, content_fingerprint, semantic_embedding,
                semantic_embedding_model, semantic_embedding_revision,
                semantic_embedding_dimensions, semantic_embedding_fingerprint
            ) VALUES (%s, 'test-ann-eligible', 'TED', 'Eligible result',
                      'https://youtu.be/eligible', '', NOW(), %s, %s::vector, %s, %s, %s, %s)
            """,
            (
                eligible_id, eligible_fingerprint, eligible_vector, embedder.model_name,
                embedder.model_revision, embedder.dimensions, eligible_fingerprint,
            ),
        )
        conn.execute("ANALYZE videos")
        conn.commit()
        conn.execute("SET LOCAL enable_seqscan = off")
        conn.execute("SET LOCAL hnsw.iterative_scan = strict_order")
        conn.execute("SET LOCAL hnsw.ef_search = 40")
        rows = _nearest_rows(conn, embedder, USER_ID, query, None, [], 5)
        assert [row["id"] for row in rows] == [eligible_id]


def test_backfill_skips_locks_honors_retry_delay_and_resumes() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    embedder = FakeEmbedder()
    video_id = uuid4()
    with (
        psycopg.connect(database_url, row_factory=dict_row) as locking_conn,
        psycopg.connect(database_url, row_factory=dict_row) as worker_conn,
    ):
        locking_conn.execute("DELETE FROM recommendations")
        locking_conn.execute("DELETE FROM videos")
        locking_conn.execute(
            """
            INSERT INTO videos (
                id, youtube_video_id, channel_name, title, youtube_url, description,
                content_fingerprint
            ) VALUES (%s, 'test-backfill-lock', 'TED', 'A comeback story',
                      'https://youtu.be/backfill', 'A team recovers after defeat.', 'fingerprint-v1')
            """,
            (video_id,),
        )
        locking_conn.commit()
        locking_conn.execute("SELECT id FROM videos WHERE id = %s FOR UPDATE", (video_id,))

        skipped = backfill_embeddings(worker_conn, embedder, retry_delay_minutes=0)
        assert skipped.attempted == 0
        locking_conn.commit()

        resumed = backfill_embeddings(worker_conn, embedder, retry_delay_minutes=0)
        assert resumed.embedded == 1
        row = worker_conn.execute(
            """
            SELECT semantic_embedding_model, semantic_embedding_revision,
                   semantic_embedding_dimensions, semantic_embedding_fingerprint,
                   semantic_embedding_attempt_count
            FROM videos WHERE id = %s
            """,
            (video_id,),
        ).fetchone()
        assert row == {
            "semantic_embedding_model": embedder.model_name,
            "semantic_embedding_revision": embedder.model_revision,
            "semantic_embedding_dimensions": embedder.dimensions,
            "semantic_embedding_fingerprint": "fingerprint-v1",
            "semantic_embedding_attempt_count": 1,
        }

        worker_conn.execute(
            "UPDATE videos SET semantic_embedding = NULL, semantic_embedding_last_attempt_at = NOW() WHERE id = %s",
            (video_id,),
        )
        worker_conn.commit()
        delayed = backfill_embeddings(worker_conn, embedder, retry_delay_minutes=5)
        assert delayed.attempted == 0
        worker_conn.execute(
            "UPDATE videos SET semantic_embedding_last_attempt_at = NOW() - INTERVAL '10 minutes' WHERE id = %s",
            (video_id,),
        )
        worker_conn.commit()
        retried = backfill_embeddings(worker_conn, embedder, retry_delay_minutes=5)
        assert retried.embedded == 1
