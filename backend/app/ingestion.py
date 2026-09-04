import hashlib
from dataclasses import dataclass
from uuid import uuid4

from psycopg import Connection

from backend.app.embedding_backfill import document_text
from backend.app.embeddings import Embedder, configured_embedder
from backend.app.settings import get_settings
from backend.app.youtube import YouTubeClient


@dataclass(frozen=True)
class IngestionSummary:
    channels_scanned: int
    videos_seen: int
    videos_changed: int


def video_fingerprint(title: str, description: str) -> str:
    return hashlib.sha256(f"{title}\n{description}".encode("utf-8")).hexdigest()


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(format(float(value), ".17g") for value in vector) + "]"


def ingest_tracked_channels(
    conn: Connection,
    youtube: YouTubeClient,
    page_limit: int = 2,
    embedder: Embedder | None = None,
) -> IngestionSummary:
    encoder = embedder or configured_embedder(get_settings())
    run_id = uuid4()
    conn.execute("INSERT INTO ingestion_runs (id, status) VALUES (%s, 'running')", (run_id,))
    conn.commit()
    channels_scanned = videos_seen = videos_changed = 0
    try:
        channels = conn.execute(
            "SELECT id, name, url, youtube_channel_id, uploads_playlist_id FROM tracked_channels ORDER BY created_at"
        ).fetchall()
        for channel in channels:
            details = youtube.resolve_channel(channel["url"], channel["youtube_channel_id"])
            conn.execute(
                "UPDATE tracked_channels SET name = %s, youtube_channel_id = %s, uploads_playlist_id = %s WHERE id = %s",
                (details.name, details.youtube_channel_id, details.uploads_playlist_id, channel["id"]),
            )
            videos = youtube.list_uploads(details.uploads_playlist_id, page_limit)
            channels_scanned += 1
            videos_seen += len(videos)

            prepared = []
            changed_documents = []
            for video in videos:
                fingerprint = video_fingerprint(video.title, video.description)
                existing = conn.execute(
                    """
                    SELECT content_fingerprint, semantic_embedding_model, semantic_embedding_revision,
                           semantic_embedding_dimensions, semantic_embedding_fingerprint
                    FROM videos WHERE youtube_video_id = %s
                    """,
                    (video.youtube_video_id,),
                ).fetchone()
                changed = (
                    not existing
                    or existing["content_fingerprint"] != fingerprint
                    or existing["semantic_embedding_model"] != encoder.model_name
                    or existing["semantic_embedding_revision"] != encoder.model_revision
                    or existing["semantic_embedding_dimensions"] != encoder.dimensions
                    or existing["semantic_embedding_fingerprint"] != fingerprint
                )
                prepared.append((video, fingerprint, changed))
                if changed:
                    changed_documents.append(document_text(video.title, video.description))

            changed_vectors = iter(encoder.embed_documents(changed_documents))
            for video, fingerprint, changed in prepared:
                vector = next(changed_vectors) if changed else None
                vector_literal = _vector_literal(vector) if vector is not None else None
                conn.execute(
                    """
                    INSERT INTO videos (
                        id, youtube_video_id, channel_name, title, speaker, youtube_url,
                        thumbnail_url, description, published_at, duration_seconds, view_count,
                        content_fingerprint, semantic_embedding, semantic_embedding_model,
                        semantic_embedding_revision, semantic_embedding_dimensions,
                        semantic_embedding_fingerprint
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s::vector, %s, %s, %s, %s
                    )
                    ON CONFLICT (youtube_video_id) DO UPDATE SET
                        channel_name = EXCLUDED.channel_name,
                        title = EXCLUDED.title,
                        speaker = EXCLUDED.speaker,
                        youtube_url = EXCLUDED.youtube_url,
                        thumbnail_url = EXCLUDED.thumbnail_url,
                        description = EXCLUDED.description,
                        published_at = EXCLUDED.published_at,
                        duration_seconds = EXCLUDED.duration_seconds,
                        view_count = EXCLUDED.view_count,
                        content_fingerprint = EXCLUDED.content_fingerprint,
                        semantic_embedding = COALESCE(EXCLUDED.semantic_embedding, videos.semantic_embedding),
                        semantic_embedding_model = COALESCE(EXCLUDED.semantic_embedding_model, videos.semantic_embedding_model),
                        semantic_embedding_revision = COALESCE(EXCLUDED.semantic_embedding_revision, videos.semantic_embedding_revision),
                        semantic_embedding_dimensions = COALESCE(EXCLUDED.semantic_embedding_dimensions, videos.semantic_embedding_dimensions),
                        semantic_embedding_fingerprint = COALESCE(EXCLUDED.semantic_embedding_fingerprint, videos.semantic_embedding_fingerprint),
                        semantic_embedding_attempt_count = CASE WHEN EXCLUDED.semantic_embedding IS NULL
                            THEN videos.semantic_embedding_attempt_count ELSE 0 END,
                        semantic_embedding_last_error = CASE WHEN EXCLUDED.semantic_embedding IS NULL
                            THEN videos.semantic_embedding_last_error ELSE NULL END,
                        updated_at = NOW()
                    """,
                    (
                        uuid4(), video.youtube_video_id, video.channel_name, video.title, video.speaker,
                        video.youtube_url, video.thumbnail_url, video.description, video.published_at,
                        video.duration_seconds, video.view_count, fingerprint, vector_literal,
                        encoder.model_name if changed else None,
                        encoder.model_revision if changed else None,
                        encoder.dimensions if changed else None,
                        fingerprint if changed else None,
                    ),
                )
                videos_changed += int(changed)
            conn.execute("UPDATE tracked_channels SET last_ingested_at = NOW() WHERE id = %s", (channel["id"],))
            conn.execute(
                """
                UPDATE videos SET channel_baseline_views = baseline.value
                FROM (
                    SELECT GREATEST(1, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY view_count)::BIGINT) AS value
                    FROM videos WHERE channel_name = %s
                ) baseline
                WHERE videos.channel_name = %s
                """,
                (details.name, details.name),
            )
            conn.commit()
        conn.execute(
            """
            UPDATE ingestion_runs SET completed_at = NOW(), status = 'completed',
                channels_scanned = %s, videos_seen = %s, videos_changed = %s
            WHERE id = %s
            """,
            (channels_scanned, videos_seen, videos_changed, run_id),
        )
        conn.commit()
        return IngestionSummary(channels_scanned, videos_seen, videos_changed)
    except Exception as exc:
        conn.rollback()
        conn.execute(
            "UPDATE ingestion_runs SET completed_at = NOW(), status = 'failed', error_message = %s WHERE id = %s",
            (str(exc)[:2000], run_id),
        )
        conn.commit()
        raise
