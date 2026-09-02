import hashlib
from dataclasses import dataclass
from uuid import uuid4

from psycopg import Connection

from backend.app.embeddings import MODEL_NAME, embed_text
from backend.app.youtube import YouTubeClient


@dataclass(frozen=True)
class IngestionSummary:
    channels_scanned: int
    videos_seen: int
    videos_changed: int


def video_fingerprint(title: str, description: str) -> str:
    return hashlib.sha256(f"{title}\n{description}".encode("utf-8")).hexdigest()


def ingest_tracked_channels(conn: Connection, youtube: YouTubeClient, page_limit: int = 2) -> IngestionSummary:
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
            for video in videos:
                fingerprint = video_fingerprint(video.title, video.description)
                existing = conn.execute(
                    "SELECT content_fingerprint FROM videos WHERE youtube_video_id = %s",
                    (video.youtube_video_id,),
                ).fetchone()
                changed = not existing or existing["content_fingerprint"] != fingerprint
                embedding = embed_text(f"{video.title}\n{video.description}") if changed else None
                conn.execute(
                    """
                    INSERT INTO videos (
                        id, youtube_video_id, channel_name, title, speaker, youtube_url,
                        thumbnail_url, description, published_at, duration_seconds, view_count,
                        content_fingerprint, embedding, embedding_model
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                        embedding = COALESCE(EXCLUDED.embedding, videos.embedding),
                        embedding_model = CASE WHEN EXCLUDED.embedding IS NULL THEN videos.embedding_model ELSE EXCLUDED.embedding_model END,
                        updated_at = NOW()
                    """,
                    (
                        uuid4(), video.youtube_video_id, video.channel_name, video.title, video.speaker,
                        video.youtube_url, video.thumbnail_url, video.description, video.published_at,
                        video.duration_seconds, video.view_count, fingerprint, embedding, MODEL_NAME,
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
