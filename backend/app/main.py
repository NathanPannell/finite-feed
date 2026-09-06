from typing import Any

import httpx
from backend.app.description_processing import DESCRIPTION_PROCESSING_VERSION
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from psycopg import Connection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from backend.app.admin import ChannelUrl, resolve_youtube_channel, router as admin_router, upsert_admin_channel
from backend.app.db import close_pool, connection, open_pool
from backend.app.deployment import deployed_source_commit
from backend.app.annotations import AnnotationConflict, annotation_stats, next_annotation, record_annotation
from backend.app.match_identity import reviewer_identity
from backend.app.openrouter import provider_failure
from backend.app.recommendations import (
    generate_recommendation as create_recommendation,
    lock_recommendation_for_delivery,
    mark_recommendation_delivered,
)
from backend.app.recommendation_queue import claim_queued_recommendation, invalidate_recommendation_queue
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
from backend.app.user_auth import current_user
from backend.app.accounts import router as account_router, consume_telegram_link
from backend.app.rate_limits import RequestLimitsMiddleware



@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


settings = get_settings()
app = FastAPI(title="Finite Feed API", version="0.1.0", lifespan=lifespan)
app.include_router(admin_router)
app.include_router(account_router)
app.add_middleware(RequestLimitsMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def worker_readiness(conn: Connection) -> dict[str, str] | None:
    heartbeat = conn.execute(
        "SELECT last_seen_at, status, commit_sha FROM worker_heartbeat WHERE worker = 'pipeline'"
    ).fetchone()
    if not heartbeat:
        return None
    return {
        "status": heartbeat["status"],
        "commit": heartbeat["commit_sha"] or "",
        "last_seen_at": heartbeat["last_seen_at"].isoformat(),
    }


@app.get("/ready")
def ready(conn: Connection = Depends(connection)) -> dict[str, Any]:
    migration_count = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()
    return {
        "status": "ready",
        "commit": deployed_source_commit(settings.app_commit_sha),
        "migrations": migration_count["count"],
        "allowed_origins": settings.allowed_origins,
        "worker": worker_readiness(conn),
    }


@app.get("/api/annotations/next", response_model=AnnotationCard | None)
def get_next_annotation(request: Request, response: Response, conn: Connection = Depends(connection)):
    reviewer_id = reviewer_identity(request, response, settings)
    return next_annotation(conn, reviewer_id)


@app.get("/api/annotations/stats", response_model=AnnotationStats)
def get_annotation_stats(request: Request, response: Response, conn: Connection = Depends(connection)):
    reviewer_id = reviewer_identity(request, response, settings)
    return annotation_stats(conn, reviewer_id)


@app.post("/api/annotations", response_model=AnnotationResult, status_code=status.HTTP_201_CREATED)
def create_annotation(
    payload: AnnotationCreate,
    request: Request,
    response: Response,
    conn: Connection = Depends(connection),
):
    reviewer_id = reviewer_identity(request, response, settings)
    try:
        row = record_annotation(
            conn,
            annotator_id=reviewer_id,
            profile_id=payload.profile_id,
            video_id=payload.video_id,
            label=payload.label,
            rationale=payload.rationale,
        )
    except AnnotationConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not row:
        raise HTTPException(status_code=404, detail="Annotation pair not found")
    if not settings.match_lab_debug_assessment:
        row["assessment"] = None
    return row


def profile_row(conn: Connection, user_id: UUID):
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
        (user_id,),
    ).fetchone()


@app.get("/api/profile", response_model=Profile)
def get_profile(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = profile_row(conn, user_id)
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")
    return row


@app.put("/api/profile", response_model=Profile)
def update_profile(payload: ProfileUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    conn.execute("SELECT id FROM app_users WHERE id=%s FOR UPDATE", (user_id,))
    current = profile_row(conn, user_id)
    if not current:
        raise HTTPException(status_code=404, detail="Profile not found")
    version = current["version"] + 1
    rendered = f"# Current preferences\n\n{payload.preference_statement}\n\n## History\n\n- Version {version} saved from the dashboard."
    conn.execute(
        "UPDATE app_users SET timezone = %s, cadence_days = %s, delivery_hour = %s, recommendation_count = %s, updated_at = NOW() WHERE id = %s",
        (payload.timezone, payload.cadence_days, payload.delivery_hour, payload.recommendation_count, user_id),
    )
    conn.execute(
        "INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source, source_message) VALUES (%s, %s, %s, %s, %s, 'dashboard', %s)",
        (uuid4(), user_id, version, payload.preference_statement, rendered, payload.preference_statement),
    )
    invalidate_recommendation_queue(conn, user_id)
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'preference_revision', 'dashboard', %s)",
        (uuid4(), user_id, Jsonb({"version": version})),
    )
    conn.commit()
    return profile_row(conn, user_id)


@app.put("/api/profile/delivery", response_model=Profile)
def update_delivery(payload: DeliveryUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    if not profile_row(conn, user_id):
        raise HTTPException(status_code=404, detail="Profile not found")
    conn.execute(
        "UPDATE app_users SET cadence_days = %s, recommendation_count = %s, timezone = COALESCE(%s, timezone), delivery_hour = COALESCE(%s, delivery_hour), updated_at = NOW() WHERE id = %s",
        (payload.cadence_days, payload.recommendation_count, payload.timezone, payload.delivery_hour, user_id),
    )
    conn.commit()
    return profile_row(conn, user_id)


@app.put("/api/profile/memory", response_model=Profile)
def update_preference_memory(payload: PreferenceMemoryUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    owner = conn.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
    current = profile_row(conn, user_id) if owner else None
    if not current:
        raise HTTPException(status_code=404, detail="Profile not found")
    if current["version"] != payload.expected_version:
        raise HTTPException(status_code=409, detail="Preference memory changed. Reload and try again.")
    version = current["version"] + 1
    rendered = f"# Current preferences\n\n{payload.preference_statement}\n\n## History\n\n- Version {version} saved from the dashboard."
    conn.execute(
        "INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source, source_message) VALUES (%s, %s, %s, %s, %s, 'dashboard', %s)",
        (uuid4(), user_id, version, payload.preference_statement, rendered, payload.preference_statement),
    )
    invalidate_recommendation_queue(conn, user_id)
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'preference_revision', 'dashboard', %s)",
        (uuid4(), user_id, Jsonb({"version": version})),
    )
    conn.commit()
    return profile_row(conn, user_id)


@app.get("/api/channels", response_model=list[Channel])
def list_channels(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    return conn.execute(
        "SELECT c.id, c.name, c.url, c.thumbnail_url, c.is_default, f.created_at FROM tracked_channels c JOIN user_channel_follows f ON f.channel_id=c.id WHERE f.user_id = %s ORDER BY c.is_default DESC, c.name",
        (user_id,),
    ).fetchall()


@app.post("/api/channels/resolve")
def resolve_public_channel(
    payload: ChannelUrl,
    user_id: UUID = Depends(current_user), conn: Connection = Depends(connection),
):
    if not settings.youtube_api_key:
        raise HTTPException(status_code=503, detail="YouTube resolver is not configured")
    try:
        details = resolve_youtube_channel(str(payload.url), settings)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(status_code=502, detail="YouTube channel lookup failed. Try again.") from exc
    existing = conn.execute(
        "SELECT f.user_id, c.is_active FROM tracked_channels c JOIN user_channel_follows f ON f.channel_id=c.id WHERE c.youtube_channel_id = %s AND f.user_id=%s",
        (details["youtube_channel_id"], user_id),
    ).fetchone()
    return {
        **details,
        "already_tracked": bool(existing and existing["user_id"] == user_id and existing["is_active"]),
        "can_reactivate": bool(existing and existing["user_id"] == user_id and not existing["is_active"]),
    }


@app.post("/api/channels", response_model=Channel, status_code=status.HTTP_201_CREATED)
def add_channel(payload: ChannelCreate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    if not settings.youtube_api_key:
        raise HTTPException(status_code=503, detail="YouTube resolver is not configured")
    try:
        details = resolve_youtube_channel(str(payload.url), settings)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("channel:" + details["youtube_channel_id"],))
        row = conn.execute("SELECT * FROM tracked_channels WHERE youtube_channel_id=%s", (details["youtube_channel_id"],)).fetchone()
        if not row:
            row, _ = upsert_admin_channel(conn, user_id=None, details=details, max_video_age_days=7, actor=None, commit=False)
        conn.execute("INSERT INTO user_channel_follows(user_id,channel_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (user_id,row["id"]))
        conn.execute(
            "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'channel_add', 'dashboard', %s)",
            (uuid4(), user_id, Jsonb({"url": details["url"]})),
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
    except (httpx.HTTPError, RuntimeError) as exc:
        conn.rollback()
        raise HTTPException(status_code=502, detail="YouTube channel lookup failed. Try again.") from exc


@app.delete("/api/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_channel(channel_id: UUID, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)) -> Response:
    row = conn.execute(
        "DELETE FROM user_channel_follows f USING tracked_channels c WHERE f.channel_id=c.id AND f.channel_id = %s AND f.user_id = %s RETURNING c.url",
        (channel_id, user_id),
    ).fetchone()
    if not row:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Channel not found")
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'channel_remove', 'dashboard', %s)",
        (uuid4(), user_id, Jsonb({"url": row["url"]})),
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
def list_recommendations(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    return conn.execute(RECOMMENDATION_SELECT, (user_id,)).fetchall()


@app.post("/api/recommendations/generate", response_model=Recommendation, status_code=status.HTTP_201_CREATED)
def generate_recommendation(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    if not settings.openrouter_api_key:
        raise HTTPException(503, "Recommendations are temporarily unavailable. Please try again later.")
    try:
        create_recommendation(conn, settings, user_id, require_model=True)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        conn.rollback()
        code, detail = provider_failure(exc)
        conn.execute(
            "UPDATE app_users SET delivery_status='waiting',delivery_error=%s WHERE id=%s AND deleted_at IS NULL",
            (code, user_id),
        )
        conn.commit()
        raise HTTPException(503, detail) from exc
    return conn.execute(RECOMMENDATION_SELECT + " LIMIT 1", (user_id,)).fetchone()


@app.post("/api/recommendations/{recommendation_id}/feedback", response_model=Recommendation)
def record_feedback(recommendation_id: UUID, payload: FeedbackCreate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    conn.execute("SELECT id FROM app_users WHERE id=%s FOR UPDATE", (user_id,)).fetchone()
    row = conn.execute(
        "UPDATE recommendations SET rating = %s WHERE id = %s AND user_id = %s RETURNING id",
        (payload.rating, recommendation_id, user_id),
    ).fetchone()
    if not row:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Recommendation not found")
    event_type = "feedback_up" if payload.rating == "up" else "feedback_down"
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source, metadata) VALUES (%s, %s, %s, %s, 'dashboard', %s)",
        (uuid4(), user_id, recommendation_id, event_type, Jsonb({"detail": payload.detail})),
    )
    invalidate_recommendation_queue(conn, user_id)
    conn.commit()
    recommendation_query = RECOMMENDATION_SELECT.replace(
        "WHERE r.user_id = %s",
        "WHERE r.user_id = %s AND r.id = %s",
    )
    return conn.execute(recommendation_query + " LIMIT 1", (user_id, recommendation_id)).fetchone()


@app.get("/r/{recommendation_id}")
def track_click(recommendation_id: UUID, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = conn.execute(
        "UPDATE recommendations r SET clicked_at = COALESCE(clicked_at, NOW()) FROM videos v WHERE r.id = %s AND r.user_id = %s AND v.id = r.video_id RETURNING v.youtube_url",
        (recommendation_id, user_id),
    ).fetchone()
    if not row:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Recommendation not found")
    conn.execute(
        "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source) VALUES (%s, %s, %s, 'clicked', 'redirect')",
        (uuid4(), user_id, recommendation_id),
    )
    conn.commit()
    return RedirectResponse(row["youtube_url"], status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@app.get("/api/metrics", response_model=Metrics)
def get_metrics(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = conn.execute(
        """
        SELECT COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
               COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
               COUNT(*) FILTER (WHERE rating = 'up') AS rated_up,
               COUNT(*) FILTER (WHERE rating = 'down') AS rated_down
        FROM recommendations WHERE user_id = %s
        """,
        (user_id,),
    ).fetchone()
    delivered, clicked = row["delivered"], row["clicked"]
    rated = row["rated_up"] + row["rated_down"]
    return {
        **row,
        "click_through_rate": round(clicked / delivered, 4) if delivered else 0,
        "thumbs_up_share": round(row["rated_up"] / rated, 4) if rated else 0,
    }


@app.get("/api/pipeline/status", response_model=PipelineStatus)
def pipeline_status(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    videos = conn.execute(
        """
        SELECT COUNT(*) AS videos,
               COUNT(*) FILTER (
                   WHERE semantic_embedding IS NOT NULL
                     AND semantic_embedding_model = %s
                     AND semantic_embedding_revision = %s
                     AND semantic_embedding_dimensions = %s
                     AND semantic_embedding_fingerprint IS NOT DISTINCT FROM (%s || ':' || content_fingerprint)
               ) AS embedded_videos,
               COUNT(*) FILTER (
                   WHERE semantic_embedding IS NULL
                      OR semantic_embedding_model IS DISTINCT FROM %s
                      OR semantic_embedding_revision IS DISTINCT FROM %s
                      OR semantic_embedding_dimensions IS DISTINCT FROM %s
                      OR semantic_embedding_fingerprint IS DISTINCT FROM (%s || ':' || content_fingerprint)
               ) AS embedding_backfill_remaining,
               COUNT(*) FILTER (WHERE semantic_embedding_last_error IS NOT NULL) AS embedding_failures
        FROM videos WHERE tracked_channel_id IN (SELECT channel_id FROM user_channel_follows WHERE user_id=%s)
        """,
        (
            settings.embedding_model, settings.embedding_model_revision, settings.embedding_dimensions,
            DESCRIPTION_PROCESSING_VERSION,
            settings.embedding_model, settings.embedding_model_revision, settings.embedding_dimensions,
            DESCRIPTION_PROCESSING_VERSION, user_id,
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
    row = conn.execute("SELECT id FROM app_users WHERE telegram_user_id = %s AND deleted_at IS NULL FOR UPDATE", (chat_id,)).fetchone()
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
    if (message.get("chat") or {}).get("type") != "private":
        return {"ok": True}
    if settings.is_preview and (bot_kind != "developer" or int(chat_id) not in settings.developer_user_ids):
        raise HTTPException(status_code=403, detail="Preview Telegram recipient is not allowed")
    update_id = update.get("update_id")
    if not isinstance(update_id, int):
        raise HTTPException(status_code=400, detail="Invalid Telegram update")
    # Hold this transaction through the account/preference mutation so retrying
    # an update cannot apply it twice, including concurrent webhook retries.
    inserted = conn.execute(
        "INSERT INTO telegram_updates (bot_kind, update_id) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING update_id",
        (bot_kind, update_id),
    ).fetchone()
    if not inserted:
        conn.commit()
        return {"ok": True, "duplicate": True}
    bot = TelegramBot(token)
    text = str(message.get("text", "")).strip()
    if text.startswith("/start "):
        user_id = consume_telegram_link(conn, text.split(" ", 1)[1], int(chat_id))
        conn.commit()
        bot.send_text(chat_id, "Telegram connected. Use /recommend, /preferences, /pause or /resume." if user_id else "This link expired, was already used, or conflicts with a linked account. Create a new link in app settings.")
        return {"ok": True}
    user_id = _telegram_user(conn, int(chat_id), bot_kind == "developer")
    if not callback and not user_id and text.isdigit() and len(text) == 6:
        user_id = consume_telegram_link(conn, text, int(chat_id))
        conn.commit()
        bot.send_text(chat_id, "Telegram connected. Use /recommend, /preferences, /pause or /resume." if user_id else "This code expired, was already used, or is invalid. Create a new code in app settings.")
        return {"ok": True}
    if not user_id:
        conn.commit()
        bot.send_text(chat_id, "Connect Telegram from your Finite Feed account settings first.")
        return {"ok": True}
    if not callback and text in {"/unlink", "/unlink confirm"}:
        if text == "/unlink":
            conn.commit()
            bot.send_text(chat_id, "Unlinking pauses delivery and disconnects this Telegram chat. Your preferences and history stay saved. Send /unlink confirm to continue, then connect from your Google account settings.")
            return {"ok": True}
        owner = conn.execute(
            "SELECT id FROM app_users WHERE id=%s AND telegram_user_id=%s AND deleted_at IS NULL FOR UPDATE",
            (user_id, chat_id),
        ).fetchone()
        if owner:
            conn.execute("DELETE FROM telegram_link_attempts WHERE chat_id=%s", (chat_id,))
            conn.execute(
                "UPDATE app_users SET telegram_user_id=NULL,delivery_paused=TRUE,updated_at=NOW() WHERE id=%s AND telegram_user_id=%s",
                (user_id, chat_id),
            )
            conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s", (user_id,))
            conn.execute(
                """UPDATE telegram_preference_confirmations SET resolved_at=NOW(),accepted=FALSE
                   WHERE user_id=%s AND resolved_at IS NULL""",
                (user_id,),
            )
        conn.commit()
        bot.send_text(chat_id, "Telegram disconnected and delivery paused. Connect again from your Google account settings." if owner else "This chat is no longer linked. Connect from your account settings.")
        return {"ok": True}
    if callback:
        parts = str(callback.get("data", "")).split(":")
        if len(parts) == 3 and parts[0] == "feedback" and parts[1] in {"up", "down"}:
            try:
                recommendation_id = UUID(parts[2])
            except ValueError:
                conn.commit()
                return {"ok": True}
            updated = conn.execute(
                "UPDATE recommendations SET rating = %s WHERE id = %s AND user_id = %s RETURNING id",
                (parts[1], recommendation_id, user_id),
            ).fetchone()
            if updated:
                conn.execute(
                    "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source) VALUES (%s, %s, %s, %s, 'telegram')",
                    (uuid4(), user_id, recommendation_id, f"feedback_{parts[1]}"),
                )
                invalidate_recommendation_queue(conn, user_id)
                conn.commit()
                bot.answer_callback(callback["id"], "Saved — more like this." if parts[1] == "up" else "Saved — less like this.")
            else:
                conn.commit()
            return {"ok": True}
        if len(parts) == 3 and parts[0] == "preference" and parts[1] in {"yes", "no"}:
            try:
                confirmation_id = UUID(parts[2])
            except ValueError:
                conn.commit()
                return {"ok": True}
            callback_user_id = (callback.get("from") or {}).get("id")
            if callback_user_id != int(chat_id):
                conn.commit()
                bot.answer_callback(callback["id"], "This preference request is not available.")
                return {"ok": True}
            confirmation = conn.execute(
                """UPDATE telegram_preference_confirmations
                   SET resolved_at=NOW(), accepted=%s
                   WHERE id=%s AND user_id=%s AND chat_id=%s
                     AND resolved_at IS NULL AND expires_at>NOW()
                   RETURNING proposed_text""",
                (parts[1] == "yes", confirmation_id, user_id, chat_id),
            ).fetchone()
            if not confirmation:
                conn.commit()
                bot.answer_callback(callback["id"], "This preference request expired or was already handled.")
                return {"ok": True}
            if parts[1] == "no":
                conn.commit()
                bot.answer_callback(callback["id"], "Okay — preferences unchanged.")
                return {"ok": True}
            current = conn.execute(
                """SELECT version, preference_statement
                   FROM preference_versions WHERE user_id=%s ORDER BY version DESC LIMIT 1""",
                (user_id,),
            ).fetchone()
            appended = f"{current['preference_statement'].rstrip()}\n\n{confirmation['proposed_text']}"
            if len(appended) > 5000:
                conn.rollback()
                conn.execute(
                    """UPDATE telegram_preference_confirmations
                       SET resolved_at=NOW(), accepted=FALSE
                       WHERE id=%s AND user_id=%s AND chat_id=%s AND resolved_at IS NULL""",
                    (confirmation_id, user_id, chat_id),
                )
                conn.commit()
                bot.answer_callback(callback["id"], "That addition would make your preferences too long.")
                return {"ok": True}
            version = current["version"] + 1
            rendered = f"# Current preferences\n\n{appended}\n\n## History\n\n- Version {version} appended from Telegram."
            conn.execute(
                """INSERT INTO preference_versions
                   (id,user_id,version,preference_statement,rendered_markdown,source,source_message)
                   VALUES (%s,%s,%s,%s,%s,'telegram',%s)""",
                (uuid4(), user_id, version, appended, rendered, confirmation["proposed_text"]),
            )
            conn.execute(
                """INSERT INTO interaction_events
                   (id,user_id,event_type,source,metadata)
                   VALUES (%s,%s,'preference_revision','telegram',%s)""",
                (uuid4(), user_id, Jsonb({"version": version, "mode": "append"})),
            )
            invalidate_recommendation_queue(conn, user_id)
            conn.commit()
            bot.answer_callback(callback["id"], "Preferences updated.")
            return {"ok": True}
        return {"ok": True}
    text = str(message.get("text", "")).strip()
    if text == "/recommend":
        # Persist Telegram update deduplication before a network send. Then reacquire
        # the account lock before the queue lock to preserve global lock ordering.
        conn.commit()
        current = conn.execute(
            """SELECT telegram_user_id,delivery_paused,deleted_at,
                      delivery_error IS NOT NULL AND last_delivery_attempt_at IS NOT NULL AND
                      last_delivery_attempt_at > NOW() - (%s * INTERVAL '1 minute') AS delivery_cooling_down
               FROM app_users WHERE id=%s FOR UPDATE""",
            (settings.delivery_retry_minutes, user_id),
        ).fetchone()
        if not current or current["deleted_at"] or current["telegram_user_id"] != chat_id:
            conn.rollback()
            return {"ok": True}
        if current["delivery_paused"] or current["delivery_cooling_down"]:
            conn.commit()
            bot.send_text(chat_id, "Delivery is paused or a recent request is still cooling down. Use /resume if paused, or try again later.")
            return {"ok": True}
        try:
            recommendation_id = claim_queued_recommendation(conn, user_id, require_model=True)
            if recommendation_id is None:
                conn.execute(
                    """UPDATE app_users SET delivery_status='waiting',delivery_error=NULL,
                       last_delivery_attempt_at=NULL WHERE id=%s AND deleted_at IS NULL""",
                    (user_id,),
                )
                conn.commit()
                bot.send_text(chat_id, "Your next recommendation is being prepared. Try again shortly.")
                return {"ok": True}
            if not current or current["deleted_at"] or current["delivery_paused"] or current["telegram_user_id"] != chat_id:
                conn.rollback()
                return {"ok": True}
            if lock_recommendation_for_delivery(conn, user_id, recommendation_id):
                bot.send_recommendation(conn, recommendation_id, current["telegram_user_id"], settings.public_app_url)
                conn.execute(
                    "UPDATE app_users SET last_delivery_attempt_at=NULL,delivery_status='ready',delivery_error=NULL WHERE id=%s",
                    (user_id,),
                )
                mark_recommendation_delivered(conn, user_id, recommendation_id, scheduled=False)
        except Exception as exc:
            conn.rollback()
            # The command is handled once; another explicit request can retry after
            # cooldown, reusing any persisted pending pick rather than spending again.
            conn.execute(
                """UPDATE app_users SET delivery_status='waiting',delivery_error=%s,
                   last_delivery_attempt_at=NOW() WHERE id=%s AND deleted_at IS NULL""",
                (str(exc)[:300] if isinstance(exc, ValueError) else "Recommendation service temporarily unavailable", user_id),
            )
            current = conn.execute(
                "SELECT telegram_user_id, delivery_paused, deleted_at FROM app_users WHERE id = %s FOR UPDATE", (user_id,),
            ).fetchone()
            if current and not current["deleted_at"] and not current["delivery_paused"] and current["telegram_user_id"] == chat_id:
                try:
                    bot.send_text(chat_id, str(exc)[:300] if isinstance(exc, ValueError) else "Your request is saved. Delivery is temporarily unavailable; try again after the cooldown.")
                except Exception:
                    pass  # A failed notification must not replay the expensive command.
            conn.commit()
    elif text == "/preferences":
        current = conn.execute(
            "SELECT preference_statement FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        bot.send_text(chat_id, current["preference_statement"])
    elif text in {"/pause", "/resume"}:
        conn.execute("UPDATE app_users SET delivery_paused=%s,updated_at=NOW() WHERE id=%s", (text == "/pause",user_id))
        conn.commit()
        bot.send_text(chat_id, "Delivery paused." if text == "/pause" else "Delivery resumed.")
    elif text.startswith("/"):
        bot.send_text(chat_id, "Use /recommend for a pick, /preferences to inspect your profile, /pause or /resume for delivery, and /unlink to disconnect this chat. Send a message to add it to your preferences.")
    elif text:
        conn.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
        conn.execute(
            """UPDATE telegram_preference_confirmations
               SET resolved_at=NOW(), accepted=FALSE
               WHERE user_id=%s AND chat_id=%s AND resolved_at IS NULL""",
            (user_id, chat_id),
        )
        confirmation_id = uuid4()
        conn.execute(
            """INSERT INTO telegram_preference_confirmations
               (id,user_id,chat_id,proposed_text,expires_at)
               VALUES (%s,%s,%s,%s,NOW()+INTERVAL '10 minutes')""",
            (confirmation_id, user_id, chat_id, text),
        )
        bot.send_preference_confirmation(chat_id, confirmation_id, text)
        # Commit only after Telegram accepted the prompt. A failed or ambiguous
        # send rolls back update deduplication so Telegram can retry at least once.
        conn.commit()
    conn.commit()
    return {"ok": True}
