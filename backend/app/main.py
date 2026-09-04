from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from psycopg import Connection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from backend.app.admin import ChannelUrl, resolve_youtube_channel, router as admin_router, upsert_admin_channel
from backend.app.db import close_pool, connection, open_pool
from backend.app.annotations import annotation_stats, next_annotation, record_annotation
from backend.app.recommendations import (
    generate_recommendation as create_recommendation,
    get_or_create_pending_recommendation,
    lock_recommendation_for_delivery,
    mark_recommendation_delivered,
)
from backend.app.schemas import (
    Channel,
    ChannelCreate,
    DeliveryUpdate,
    FeedbackCreate,
    Metrics,
    PipelineStatus,
    PreferenceMemoryUpdate,
    Profile,
    ProfileUpdate,
    Recommendation,
)
from backend.app.schemas import AnnotationCard, AnnotationCreate, AnnotationResult, AnnotationStats
from backend.app.settings import get_settings
from backend.app.telegram import TelegramBot

USER_ID = UUID("00000000-0000-0000-0000-000000000001")


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


settings = get_settings()
app = FastAPI(title="Finite Feed API", version="0.1.0", lifespan=lifespan)
app.include_router(admin_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready(conn: Connection = Depends(connection)) -> dict[str, str | int | list[str]]:
    migration_count = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()
    return {
        "status": "ready",
        "commit": settings.app_commit_sha,
        "migrations": migration_count["count"],
        "allowed_origins": settings.allowed_origins,
    }


@app.get("/api/annotations/next", response_model=AnnotationCard | None)
def get_next_annotation(annotator_id: UUID, conn: Connection = Depends(connection)):
    return next_annotation(conn, annotator_id)


@app.get("/api/annotations/stats", response_model=AnnotationStats)
def get_annotation_stats(annotator_id: UUID, conn: Connection = Depends(connection)):
    return annotation_stats(conn, annotator_id)


@app.post("/api/annotations", response_model=AnnotationResult, status_code=status.HTTP_201_CREATED)
def create_annotation(payload: AnnotationCreate, conn: Connection = Depends(connection)):
    row = record_annotation(
        conn,
        annotator_id=payload.annotator_id,
        profile_id=payload.profile_id,
        video_id=payload.video_id,
        label=payload.label,
        rationale=payload.rationale,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Annotation pair not found")
    return row


def profile_row(conn: Connection):
    return conn.execute(
        """
        SELECT p.version, p.preference_statement, p.rendered_markdown, p.created_at AS updated_at,
               u.timezone, u.cadence_days, u.delivery_hour, u.recommendation_count
        FROM app_users u
        JOIN LATERAL (
            SELECT version, preference_statement, rendered_markdown, created_at
            FROM preference_versions WHERE user_id = u.id ORDER BY version DESC LIMIT 1
        ) p ON TRUE
        WHERE u.id = %s
        """,
        (USER_ID,),
    ).fetchone()


@app.get("/api/profile", response_model=Profile)
def get_profile(conn: Connection = Depends(connection)):
    row = profile_row(conn)
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")
    return row


@app.put("/api/profile", response_model=Profile)
def update_profile(payload: ProfileUpdate, conn: Connection = Depends(connection)):
    current = profile_row(conn)
    if not current:
        raise HTTPException(status_code=404, detail="Profile not found")
    version = current["version"] + 1
    rendered = f"# Current preferences\n\n{payload.preference_statement}\n\n## History\n\n- Version {version} saved from the dashboard."
    conn.execute(
        "UPDATE app_users SET timezone = %s, cadence_days = %s, delivery_hour = %s, recommendation_count = %s, updated_at = NOW() WHERE id = %s",
        (payload.timezone, payload.cadence_days, payload.delivery_hour, payload.recommendation_count, USER_ID),
    )
    conn.execute(
        "INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source, source_message) VALUES (%s, %s, %s, %s, %s, 'dashboard', %s)",
        (uuid4(), USER_ID, version, payload.preference_statement, rendered, payload.preference_statement),
    )
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'preference_revision', 'dashboard', %s)",
        (uuid4(), USER_ID, Jsonb({"version": version})),
    )
    conn.commit()
    return profile_row(conn)


@app.put("/api/profile/delivery", response_model=Profile)
def update_delivery(payload: DeliveryUpdate, conn: Connection = Depends(connection)):
    if not profile_row(conn):
        raise HTTPException(status_code=404, detail="Profile not found")
    conn.execute(
        "UPDATE app_users SET cadence_days = %s, recommendation_count = %s, updated_at = NOW() WHERE id = %s",
        (payload.cadence_days, payload.recommendation_count, USER_ID),
    )
    conn.commit()
    return profile_row(conn)


@app.put("/api/profile/memory", response_model=Profile)
def update_preference_memory(payload: PreferenceMemoryUpdate, conn: Connection = Depends(connection)):
    owner = conn.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (USER_ID,)).fetchone()
    current = profile_row(conn) if owner else None
    if not current:
        raise HTTPException(status_code=404, detail="Profile not found")
    if current["version"] != payload.expected_version:
        raise HTTPException(status_code=409, detail="Preference memory changed. Reload and try again.")
    version = current["version"] + 1
    rendered = f"# Current preferences\n\n{payload.preference_statement}\n\n## History\n\n- Version {version} saved from the dashboard."
    conn.execute(
        "INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source, source_message) VALUES (%s, %s, %s, %s, %s, 'dashboard', %s)",
        (uuid4(), USER_ID, version, payload.preference_statement, rendered, payload.preference_statement),
    )
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'preference_revision', 'dashboard', %s)",
        (uuid4(), USER_ID, Jsonb({"version": version})),
    )
    conn.commit()
    return profile_row(conn)


@app.get("/api/channels", response_model=list[Channel])
def list_channels(conn: Connection = Depends(connection)):
    return conn.execute(
        "SELECT id, name, url, thumbnail_url, is_default, created_at FROM tracked_channels WHERE user_id = %s AND is_active ORDER BY is_default DESC, name",
        (USER_ID,),
    ).fetchall()


@app.post("/api/channels/resolve")
def resolve_public_channel(
    payload: ChannelUrl,
    conn: Connection = Depends(connection),
):
    if not settings.youtube_api_key:
        raise HTTPException(status_code=503, detail="YouTube resolver is not configured")
    try:
        details = resolve_youtube_channel(str(payload.url), settings)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="YouTube channel lookup failed. Try again.") from exc
    existing = conn.execute(
        "SELECT user_id, is_active FROM tracked_channels WHERE youtube_channel_id = %s",
        (details["youtube_channel_id"],),
    ).fetchone()
    return {
        **details,
        "already_tracked": bool(existing and existing["user_id"] == USER_ID and existing["is_active"]),
        "can_reactivate": bool(existing and existing["user_id"] == USER_ID and not existing["is_active"]),
    }


@app.post("/api/channels", response_model=Channel, status_code=status.HTTP_201_CREATED)
def add_channel(payload: ChannelCreate, conn: Connection = Depends(connection)):
    if not settings.youtube_api_key:
        raise HTTPException(status_code=503, detail="YouTube resolver is not configured")
    try:
        details = resolve_youtube_channel(str(payload.url), settings)
        row, _ = upsert_admin_channel(
            conn,
            user_id=USER_ID,
            details=details,
            max_video_age_days=7,
            actor=None,
            commit=False,
        )
        conn.execute(
            "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'channel_add', 'dashboard', %s)",
            (uuid4(), USER_ID, Jsonb({"url": details["url"]})),
        )
        conn.commit()
        return row
    except HTTPException:
        conn.rollback()
        raise
    except UniqueViolation as exc:
        conn.rollback()
        raise HTTPException(status_code=409, detail="That channel is already tracked") from exc
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        conn.rollback()
        raise HTTPException(status_code=502, detail="YouTube channel lookup failed. Try again.") from exc


@app.delete("/api/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_channel(channel_id: UUID, conn: Connection = Depends(connection)) -> Response:
    row = conn.execute(
        "UPDATE tracked_channels SET is_active = FALSE WHERE id = %s AND user_id = %s RETURNING url",
        (channel_id, USER_ID),
    ).fetchone()
    if not row:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Channel not found")
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'channel_remove', 'dashboard', %s)",
        (uuid4(), USER_ID, Jsonb({"url": row["url"]})),
    )
    conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


RECOMMENDATION_SELECT = """
SELECT r.id, r.video_id, v.title, v.speaker, v.channel_name, v.youtube_url, v.thumbnail_url,
       v.published_at, v.duration_seconds, r.rationale, r.evidence, r.rating,
       r.clicked_at, r.delivered_at, r.created_at
FROM recommendations r JOIN videos v ON v.id = r.video_id
WHERE r.user_id = %s
ORDER BY r.created_at DESC
"""


@app.get("/api/recommendations", response_model=list[Recommendation])
def list_recommendations(conn: Connection = Depends(connection)):
    return conn.execute(RECOMMENDATION_SELECT, (USER_ID,)).fetchall()


@app.post("/api/recommendations/generate", response_model=Recommendation, status_code=status.HTTP_201_CREATED)
def generate_recommendation(conn: Connection = Depends(connection)):
    try:
        create_recommendation(conn, settings, USER_ID)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return conn.execute(RECOMMENDATION_SELECT + " LIMIT 1", (USER_ID,)).fetchone()


@app.post("/api/recommendations/{recommendation_id}/feedback", response_model=Recommendation)
def record_feedback(recommendation_id: UUID, payload: FeedbackCreate, conn: Connection = Depends(connection)):
    row = conn.execute(
        "UPDATE recommendations SET rating = %s WHERE id = %s AND user_id = %s RETURNING id",
        (payload.rating, recommendation_id, USER_ID),
    ).fetchone()
    if not row:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Recommendation not found")
    event_type = "feedback_up" if payload.rating == "up" else "feedback_down"
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source, metadata) VALUES (%s, %s, %s, %s, 'dashboard', %s)",
        (uuid4(), USER_ID, recommendation_id, event_type, Jsonb({"detail": payload.detail})),
    )
    conn.commit()
    recommendation_query = RECOMMENDATION_SELECT.replace(
        "WHERE r.user_id = %s",
        "WHERE r.user_id = %s AND r.id = %s",
    )
    return conn.execute(recommendation_query + " LIMIT 1", (USER_ID, recommendation_id)).fetchone()


@app.get("/r/{recommendation_id}")
def track_click(recommendation_id: UUID, conn: Connection = Depends(connection)):
    row = conn.execute(
        "UPDATE recommendations r SET clicked_at = COALESCE(clicked_at, NOW()) FROM videos v WHERE r.id = %s AND r.user_id = %s AND v.id = r.video_id RETURNING v.youtube_url",
        (recommendation_id, USER_ID),
    ).fetchone()
    if not row:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Recommendation not found")
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source) VALUES (%s, %s, %s, 'clicked', 'redirect')",
        (uuid4(), USER_ID, recommendation_id),
    )
    conn.commit()
    return RedirectResponse(row["youtube_url"], status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@app.get("/api/metrics", response_model=Metrics)
def get_metrics(conn: Connection = Depends(connection)):
    row = conn.execute(
        """
        SELECT COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
               COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
               COUNT(*) FILTER (WHERE rating = 'up') AS rated_up,
               COUNT(*) FILTER (WHERE rating = 'down') AS rated_down
        FROM recommendations WHERE user_id = %s
        """,
        (USER_ID,),
    ).fetchone()
    delivered, clicked = row["delivered"], row["clicked"]
    rated = row["rated_up"] + row["rated_down"]
    return {
        **row,
        "click_through_rate": round(clicked / delivered, 4) if delivered else 0,
        "thumbs_up_share": round(row["rated_up"] / rated, 4) if rated else 0,
    }


@app.get("/api/pipeline/status", response_model=PipelineStatus)
def pipeline_status(conn: Connection = Depends(connection)):
    videos = conn.execute(
        """
        SELECT COUNT(*) AS videos,
               COUNT(*) FILTER (
                   WHERE semantic_embedding IS NOT NULL
                     AND semantic_embedding_model = %s
                     AND semantic_embedding_revision = %s
                     AND semantic_embedding_dimensions = %s
                     AND semantic_embedding_fingerprint IS NOT DISTINCT FROM content_fingerprint
               ) AS embedded_videos,
               COUNT(*) FILTER (
                   WHERE semantic_embedding IS NULL
                      OR semantic_embedding_model IS DISTINCT FROM %s
                      OR semantic_embedding_revision IS DISTINCT FROM %s
                      OR semantic_embedding_dimensions IS DISTINCT FROM %s
                      OR semantic_embedding_fingerprint IS DISTINCT FROM content_fingerprint
               ) AS embedding_backfill_remaining,
               COUNT(*) FILTER (WHERE semantic_embedding_last_error IS NOT NULL) AS embedding_failures
        FROM videos
        """,
        (
            settings.embedding_model, settings.embedding_model_revision, settings.embedding_dimensions,
            settings.embedding_model, settings.embedding_model_revision, settings.embedding_dimensions,
        ),
    ).fetchone()
    ingestion = conn.execute(
        "SELECT status, completed_at, videos_seen FROM ingestion_runs ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    return {
        **videos,
        "last_ingestion_status": ingestion["status"] if ingestion else None,
        "last_ingestion_at": ingestion["completed_at"] if ingestion else None,
        "last_ingestion_videos_seen": ingestion["videos_seen"] if ingestion else 0,
    }


def _telegram_user(conn: Connection, chat_id: int, developer: bool):
    row = conn.execute("SELECT id FROM app_users WHERE telegram_user_id = %s", (chat_id,)).fetchone()
    if row:
        return row["id"]
    may_claim_dogfood_profile = chat_id in settings.developer_user_ids if developer else chat_id == settings.production_chat_id
    if not may_claim_dogfood_profile:
        return None
    row = conn.execute(
        "UPDATE app_users SET telegram_user_id = %s, updated_at = NOW() WHERE id = %s AND telegram_user_id IS NULL RETURNING id",
        (chat_id, USER_ID),
    ).fetchone()
    conn.commit()
    return row["id"] if row else None


def _forget_telegram_update(conn: Connection, bot_kind: str, update_id: int) -> None:
    conn.rollback()
    conn.execute(
        "DELETE FROM telegram_updates WHERE bot_kind = %s AND update_id = %s",
        (bot_kind, update_id),
    )
    conn.commit()


@app.post("/telegram/webhook/{bot_kind}")
def telegram_webhook(
    bot_kind: str,
    update: dict,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
    conn: Connection = Depends(connection),
):
    if bot_kind not in {"production", "developer"}:
        raise HTTPException(status_code=404, detail="Unknown bot")
    if not settings.telegram_webhook_secret or x_telegram_bot_api_secret_token != settings.telegram_webhook_secret:
        raise HTTPException(status_code=401, detail="Invalid Telegram webhook secret")
    token = settings.telegram_production_bot_token if bot_kind == "production" else settings.telegram_developer_bot_token
    if not token:
        raise HTTPException(status_code=503, detail="Telegram bot is not configured")
    callback = update.get("callback_query")
    message = update.get("message") or (callback or {}).get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    if chat_id is None:
        return {"ok": True}
    user_id = _telegram_user(conn, int(chat_id), bot_kind == "developer")
    if not user_id:
        raise HTTPException(status_code=403, detail="Telegram user is not authorized")
    update_id = update.get("update_id")
    if not isinstance(update_id, int):
        raise HTTPException(status_code=400, detail="Invalid Telegram update")
    inserted = conn.execute(
        "INSERT INTO telegram_updates (bot_kind, update_id) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING update_id",
        (bot_kind, update_id),
    ).fetchone()
    conn.commit()
    if not inserted:
        return {"ok": True, "duplicate": True}
    bot = TelegramBot(token)
    if callback:
        parts = str(callback.get("data", "")).split(":")
        if len(parts) == 3 and parts[0] == "feedback" and parts[1] in {"up", "down"}:
            recommendation_id = UUID(parts[2])
            updated = conn.execute(
                "UPDATE recommendations SET rating = %s WHERE id = %s AND user_id = %s RETURNING id",
                (parts[1], recommendation_id, user_id),
            ).fetchone()
            if updated:
                conn.execute(
                    "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source) VALUES (%s, %s, %s, %s, 'telegram')",
                    (uuid4(), user_id, recommendation_id, f"feedback_{parts[1]}"),
                )
                conn.commit()
                bot.answer_callback(callback["id"], "Saved — more like this." if parts[1] == "up" else "Saved — less like this.")
        return {"ok": True}
    text = str(message.get("text", "")).strip()
    if text == "/recommend":
        try:
            recommendation_id = get_or_create_pending_recommendation(conn, settings, user_id, require_model=True)
            if lock_recommendation_for_delivery(conn, user_id, recommendation_id):
                bot.send_recommendation(conn, recommendation_id, chat_id, settings.public_app_url)
                mark_recommendation_delivered(conn, user_id, recommendation_id, scheduled=False)
        except Exception:
            _forget_telegram_update(conn, bot_kind, update_id)
            raise
    elif text == "/preferences":
        current = conn.execute(
            "SELECT preference_statement FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        bot.send_text(chat_id, current["preference_statement"])
    elif text.startswith("/"):
        bot.send_text(chat_id, "Use /recommend for a new pick, or /preferences to inspect your current profile.")
    elif len(text) >= 10:
        current = conn.execute(
            "SELECT version, rendered_markdown FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        version = current["version"] + 1
        rendered = f"# Current preferences\n\n{text}\n\n## History\n\n- Version {version} applied from Telegram."
        conn.execute(
            "INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source, source_message) VALUES (%s, %s, %s, %s, %s, 'telegram', %s)",
            (uuid4(), user_id, version, text, rendered, text),
        )
        conn.execute(
            "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'preference_revision', 'telegram', %s)",
            (uuid4(), user_id, Jsonb({"version": version})),
        )
        conn.commit()
        bot.send_text(chat_id, "Updated your preference profile. I’ll use that on the next recommendation.")
    return {"ok": True}
