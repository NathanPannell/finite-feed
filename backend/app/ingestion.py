import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from psycopg import Connection

from backend.app.embedding_backfill import document_text
from backend.app.description_processing import document_fingerprint
from backend.app.embeddings import Embedder, configured_embedder
from backend.app.settings import get_settings
from backend.app.youtube import ChannelDetails, UploadPage, YouTubeClient, YouTubeVideo

DEFAULT_BACKFILL_LIMIT = 10


@dataclass(frozen=True)
class IngestionSummary:
    channels_scanned: int
    videos_seen: int
    videos_changed: int
    channels_failed: int = 0


def video_fingerprint(title: str, description: str) -> str:
    return hashlib.sha256(f"{title}\n{description}".encode("utf-8")).hexdigest()


def _in_horizon(video: YouTubeVideo, cutoff: datetime) -> bool:
    return video.published_at is None or video.published_at >= cutoff


def _oldest_published(videos: list[YouTubeVideo]) -> datetime | None:
    published = [video.published_at for video in videos if video.published_at is not None]
    return min(published) if published else None


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(format(float(value), ".17g") for value in vector) + "]"


def _store_videos(
    conn: Connection,
    tracked_channel_id,
    videos: list[YouTubeVideo],
    encoder: Embedder,
) -> int:
    prepared = []
    changed_documents = []
    for video in videos:
        fingerprint = video_fingerprint(video.title, video.description)
        embedding_fingerprint = document_fingerprint(fingerprint)
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
            or existing["semantic_embedding_fingerprint"] != embedding_fingerprint
        )
        prepared.append((video, fingerprint, embedding_fingerprint, changed))
        if changed:
            changed_documents.append(document_text(video.title, video.description))

    vectors = iter(encoder.embed_documents(changed_documents))
    changed_count = 0
    for video, fingerprint, embedding_fingerprint, changed in prepared:
        vector_literal = _vector_literal(next(vectors)) if changed else None
        conn.execute(
            """
            INSERT INTO videos (
                id, youtube_video_id, tracked_channel_id, channel_name, title, speaker,
                youtube_url, thumbnail_url, description, default_language,
                default_audio_language, published_at, duration_seconds,
                view_count, content_fingerprint, semantic_embedding, semantic_embedding_model,
                semantic_embedding_revision, semantic_embedding_dimensions,
                semantic_embedding_fingerprint
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s::vector, %s, %s, %s, %s
            )
            ON CONFLICT (youtube_video_id) DO UPDATE SET
                is_available = TRUE,
                tracked_channel_id = EXCLUDED.tracked_channel_id,
                channel_name = EXCLUDED.channel_name,
                title = EXCLUDED.title,
                speaker = EXCLUDED.speaker,
                youtube_url = EXCLUDED.youtube_url,
                thumbnail_url = EXCLUDED.thumbnail_url,
                description = EXCLUDED.description,
                default_language = EXCLUDED.default_language,
                default_audio_language = EXCLUDED.default_audio_language,
                published_at = EXCLUDED.published_at,
                duration_seconds = EXCLUDED.duration_seconds,
                view_count = EXCLUDED.view_count,
                content_fingerprint = EXCLUDED.content_fingerprint,
                semantic_embedding = COALESCE(EXCLUDED.semantic_embedding, videos.semantic_embedding),
                semantic_embedding_model = COALESCE(
                    EXCLUDED.semantic_embedding_model, videos.semantic_embedding_model
                ),
                semantic_embedding_revision = COALESCE(
                    EXCLUDED.semantic_embedding_revision, videos.semantic_embedding_revision
                ),
                semantic_embedding_dimensions = COALESCE(
                    EXCLUDED.semantic_embedding_dimensions, videos.semantic_embedding_dimensions
                ),
                semantic_embedding_fingerprint = COALESCE(
                    EXCLUDED.semantic_embedding_fingerprint, videos.semantic_embedding_fingerprint
                ),
                semantic_embedding_attempt_count = CASE
                    WHEN EXCLUDED.semantic_embedding IS NULL
                    THEN videos.semantic_embedding_attempt_count ELSE 0 END,
                semantic_embedding_last_error = CASE
                    WHEN EXCLUDED.semantic_embedding IS NULL
                    THEN videos.semantic_embedding_last_error ELSE NULL END,
                updated_at = NOW()
            """,
            (
                uuid4(), video.youtube_video_id, tracked_channel_id, video.channel_name,
                video.title, video.speaker, video.youtube_url, video.thumbnail_url,
                video.description, video.default_language, video.default_audio_language,
                video.published_at, video.duration_seconds,
                video.view_count, fingerprint, vector_literal,
                encoder.model_name if changed else None,
                encoder.model_revision if changed else None,
                encoder.dimensions if changed else None,
                embedding_fingerprint if changed else None,
            ),
        )
        changed_count += int(changed)
    return changed_count

def _update_channel_baseline(conn: Connection, tracked_channel_id) -> None:
    conn.execute(
        """
        UPDATE videos SET channel_baseline_views = baseline.value
        FROM (
            SELECT GREATEST(
                1,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY view_count)::BIGINT
            ) AS value
            FROM videos WHERE tracked_channel_id = %s
        ) baseline
        WHERE videos.tracked_channel_id = %s
        """,
        (tracked_channel_id, tracked_channel_id),
    )


def _mark_channel_sync_started(conn: Connection, channel_id) -> bool:
    started = conn.execute(
        """
        UPDATE tracked_channels
        SET last_sync_started_at = NOW(), sync_status = 'running', sync_error = NULL
        WHERE id = %s AND is_active = TRUE
        RETURNING id
        """,
        (channel_id,),
    ).fetchone()
    conn.commit()
    return started is not None


def _mark_channel_sync_failed(conn: Connection, channel_id, exc: Exception) -> None:
    conn.rollback()
    conn.execute(
        """
        UPDATE tracked_channels
        SET last_sync_completed_at = NOW(), sync_status = 'failed', sync_error = %s
        WHERE id = %s
        """,
        (str(exc)[:2000], channel_id),
    )
    conn.commit()


def _mark_channel_sync_completed(conn: Connection, channel_id) -> None:
    conn.execute(
        """
        UPDATE tracked_channels
        SET last_sync_completed_at = NOW(), last_ingested_at = NOW(),
            sync_status = 'completed', sync_error = NULL
        WHERE id = %s
        """,
        (channel_id,),
    )
    conn.commit()


def _recent_phase(
    conn: Connection,
    youtube: YouTubeClient,
    channel: dict,
    page_limit: int,
    now: datetime,
    encoder: Embedder,
) -> tuple[int, int]:
    details: ChannelDetails = youtube.resolve_channel(channel["url"], channel["youtube_channel_id"])
    cutoff = now - timedelta(days=channel["max_video_age_days"])
    videos: list[YouTubeVideo] = []
    page_token: str | None = None
    next_page_token: str | None = None
    reached_boundary = False
    seen = 0
    for _ in range(page_limit):
        page: UploadPage = youtube.list_upload_page(
            details.uploads_playlist_id,
            page_token=page_token,
            max_results=50,
        )
        _mark_unavailable(conn, page)
        seen += len(page.videos)
        videos.extend(video for video in page.videos if _in_horizon(video, cutoff))
        reached_boundary = any(
            video.published_at is not None and video.published_at < cutoff
            for video in page.videos
        )
        next_page_token = page.next_page_token
        if reached_boundary or not next_page_token:
            break
        page_token = next_page_token

    changed = _store_videos(conn, channel["id"], videos, encoder)
    backfill_page_token = channel["backfill_page_token"]
    backfill_completed_at = channel["backfill_completed_at"]
    if backfill_page_token is None and backfill_completed_at is None:
        if reached_boundary or next_page_token is None:
            backfill_completed_at = now
        else:
            backfill_page_token = next_page_token
    oldest_published_at = _oldest_published(videos)
    conn.execute(
        """
        UPDATE tracked_channels
        SET name = %s, youtube_channel_id = %s, uploads_playlist_id = %s,
            thumbnail_url = %s, description = %s, subscriber_count = %s,
            public_video_count = %s, metadata_updated_at = NOW(),
            backfill_page_token = %s, backfill_completed_at = %s,
            backfill_oldest_published_at = CASE
                WHEN %s::TIMESTAMPTZ IS NULL THEN backfill_oldest_published_at
                WHEN backfill_oldest_published_at IS NULL THEN %s::TIMESTAMPTZ
                ELSE LEAST(backfill_oldest_published_at, %s::TIMESTAMPTZ)
            END
        WHERE id = %s
        """,
        (
            details.name, details.youtube_channel_id, details.uploads_playlist_id,
            details.thumbnail_url, details.description, details.subscriber_count,
            details.public_video_count, backfill_page_token, backfill_completed_at,
            oldest_published_at, oldest_published_at, oldest_published_at, channel["id"],
        ),
    )
    _update_channel_baseline(conn, channel["id"])
    conn.commit()
    return seen, changed


def _backfill_phase(
    conn: Connection,
    youtube: YouTubeClient,
    channel_id,
    backfill_limit: int,
    now: datetime,
    encoder: Embedder,
) -> tuple[int, int]:
    channel = conn.execute(
        """
        SELECT id, uploads_playlist_id, max_video_age_days, backfill_page_token,
               backfill_completed_at
        FROM tracked_channels WHERE id = %s AND is_active = TRUE
        """,
        (channel_id,),
    ).fetchone()
    if not channel or channel["backfill_completed_at"] is not None or not channel["backfill_page_token"]:
        return 0, 0
    cutoff = now - timedelta(days=channel["max_video_age_days"])
    page: UploadPage = youtube.list_upload_page(
        channel["uploads_playlist_id"],
        page_token=channel["backfill_page_token"],
        max_results=backfill_limit,
    )
    _mark_unavailable(conn, page)
    videos = [video for video in page.videos if _in_horizon(video, cutoff)]
    reached_boundary = any(
        video.published_at is not None and video.published_at < cutoff
        for video in page.videos
    ) or page.next_page_token is None
    changed = _store_videos(conn, channel_id, videos, encoder)
    oldest_published_at = _oldest_published(videos)
    conn.execute(
        """
        UPDATE tracked_channels
        SET backfill_page_token = %s,
            backfill_completed_at = CASE WHEN %s THEN NOW() ELSE NULL END,
            backfill_oldest_published_at = CASE
                WHEN %s::TIMESTAMPTZ IS NULL THEN backfill_oldest_published_at
                WHEN backfill_oldest_published_at IS NULL THEN %s::TIMESTAMPTZ
                ELSE LEAST(backfill_oldest_published_at, %s::TIMESTAMPTZ)
            END
        WHERE id = %s
        """,
        (
            None if reached_boundary else page.next_page_token,
            reached_boundary,
            oldest_published_at,
            oldest_published_at,
            oldest_published_at,
            channel_id,
        ),
    )
    _update_channel_baseline(conn, channel_id)
    conn.commit()
    return len(page.videos), changed


def _ingest_tracked_channels(
    conn: Connection,
    youtube: YouTubeClient,
    page_limit: int = 2,
    backfill_limit: int = DEFAULT_BACKFILL_LIMIT,
    embedder: Embedder | None = None,
    sync_interval_hours: int | None = None,
    retry_minutes: int = 30,
) -> IngestionSummary:
    if not 1 <= backfill_limit <= 10:
        raise ValueError("backfill_limit must be between 1 and 10")
    if sync_interval_hours is not None and sync_interval_hours < 1:
        raise ValueError("sync_interval_hours must be at least 1")
    if retry_minutes < 1:
        raise ValueError("retry_minutes must be at least 1")
    encoder = embedder or configured_embedder(get_settings())
    run_id = uuid4()
    conn.execute("INSERT INTO ingestion_runs (id, status) VALUES (%s, 'running')", (run_id,))
    conn.commit()
    channels_scanned = videos_seen = videos_changed = 0
    failures: list[str] = []
    recent_successes: list = []
    try:
        due_filter = ""
        due_params: tuple = ()
        if sync_interval_hours is not None:
            due_filter = """
              AND (
                    last_sync_started_at IS NULL
                    OR (
                        sync_status IN ('failed', 'running')
                        AND COALESCE(last_sync_completed_at, last_sync_started_at)
                            <= NOW() - (%s * INTERVAL '1 minute')
                    )
                    OR (
                        sync_status NOT IN ('failed', 'running')
                        AND COALESCE(last_sync_completed_at, last_sync_started_at)
                            <= NOW() - (%s * INTERVAL '1 hour')
                    )
              )
            """
            due_params = (retry_minutes, sync_interval_hours)
        channels = conn.execute(
            f"""
            SELECT id, name, url, youtube_channel_id, uploads_playlist_id,
                   max_video_age_days, backfill_page_token, backfill_completed_at
            FROM tracked_channels
            WHERE is_active = TRUE
            {due_filter}
            ORDER BY created_at
            """,
            due_params,
        ).fetchall()
        now = datetime.now(UTC)

        # Complete the recent scan for every active channel before any historical work.
        for channel in channels:
            channels_scanned += 1
            if not _mark_channel_sync_started(conn, channel["id"]):
                continue
            try:
                seen, changed = _recent_phase(conn, youtube, channel, page_limit, now, encoder)
                videos_seen += seen
                videos_changed += changed
                recent_successes.append(channel["id"])
            except Exception as exc:
                _mark_channel_sync_failed(conn, channel["id"], exc)
                failures.append(f"{channel['id']}: {str(exc)[:500]}")

        # Historical work is deliberately small and only starts after all recent scans.
        for channel_id in recent_successes:
            try:
                seen, changed = _backfill_phase(conn, youtube, channel_id, backfill_limit, now, encoder)
                videos_seen += seen
                videos_changed += changed
                _mark_channel_sync_completed(conn, channel_id)
            except Exception as exc:
                _mark_channel_sync_failed(conn, channel_id, exc)
                failures.append(f"{channel_id}: {str(exc)[:500]}")

        status = "failed" if failures else "completed"
        conn.execute(
            """
            UPDATE ingestion_runs SET completed_at = NOW(), status = %s,
                channels_scanned = %s, videos_seen = %s, videos_changed = %s,
                error_message = %s
            WHERE id = %s
            """,
            (
                status, channels_scanned, videos_seen, videos_changed,
                "; ".join(failures)[:2000] or None, run_id,
            ),
        )
        conn.commit()
        return IngestionSummary(channels_scanned, videos_seen, videos_changed, len(failures))
    except Exception as exc:
        conn.rollback()
        conn.execute(
            """
            UPDATE ingestion_runs SET completed_at = NOW(), status = 'failed',
                channels_scanned = %s, videos_seen = %s, videos_changed = %s,
                error_message = %s
            WHERE id = %s
            """,
            (channels_scanned, videos_seen, videos_changed, str(exc)[:2000], run_id),
        )
        conn.commit()
        raise


def _mark_unavailable(conn, page):
    if page.unavailable_ids:
        conn.execute("UPDATE videos SET is_available = FALSE WHERE youtube_video_id = ANY(%s)", (page.unavailable_ids,))


def ingest_tracked_channels(conn, youtube, page_limit=2, backfill_limit=DEFAULT_BACKFILL_LIMIT,
                            embedder=None, sync_interval_hours=None, retry_minutes=30):
    # Transaction advisory locks work with Neon's transaction pooler. The persisted
    # running row becomes the lease once the ingestion run is committed.
    conn.execute("SELECT pg_advisory_xact_lock(4182014)")
    running = conn.execute("""SELECT id FROM ingestion_runs WHERE status = 'running'
                            AND started_at > NOW() - INTERVAL '30 minutes' LIMIT 1""").fetchone()
    if running:
        conn.rollback()
        return IngestionSummary(0, 0, 0)
    return _ingest_tracked_channels(conn, youtube, page_limit, backfill_limit, embedder,
                                    sync_interval_hours, retry_minutes)
