from datetime import datetime
from typing import Any, Literal
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from psycopg import Connection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import AnyHttpUrl, BaseModel, Field, field_validator, model_validator

from backend.app.admin_auth import require_admin
from backend.app.db import connection
from backend.app.embeddings import configured_embedder
from backend.app.settings import Settings, get_settings
from backend.app.youtube import YouTubeClient

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])
MAX_PAGE_SIZE = 100


class ChannelUrl(BaseModel):
    url: AnyHttpUrl = Field(max_length=2048)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: AnyHttpUrl) -> AnyHttpUrl:
        parse_channel_reference(str(value))
        return value


class ChannelCreate(ChannelUrl):
    user_id: UUID | None = None
    max_video_age_days: int = Field(default=7, ge=1, le=365)


class ChannelPatch(BaseModel):
    is_active: bool | None = None
    max_video_age_days: int | None = Field(default=None, ge=1, le=365)

    @model_validator(mode="after")
    def exactly_one_change(self) -> "ChannelPatch":
        supplied = sum(value is not None for value in (self.is_active, self.max_video_age_days))
        if supplied != 1:
            raise ValueError("Change exactly one of is_active or max_video_age_days")
        return self


class VectorSearch(BaseModel):
    phrase: str = Field(min_length=1, max_length=500)
    model: str | None = Field(default=None, min_length=1, max_length=120)
    limit: int = Field(default=20, ge=1, le=100)

    @field_validator("phrase")
    @classmethod
    def normalize_phrase(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Phrase cannot be blank")
        return normalized


def parse_channel_reference(url: str) -> tuple[str, str]:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or hostname not in {
        "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"
    }:
        raise ValueError("Use a YouTube channel or video URL")
    parts = [part for part in parsed.path.split("/") if part]
    if hostname == "youtu.be" and len(parts) == 1:
        return "video", parts[0]
    if len(parts) == 2 and parts[0] == "channel" and parts[1].startswith("UC") and len(parts[1]) == 24:
        return "id", parts[1]
    if len(parts) == 1 and parts[0].startswith("@") and len(parts[0]) > 1:
        return "forHandle", parts[0][1:]
    if parsed.path == "/watch":
        video_ids = parse_qs(parsed.query).get("v", [])
        if len(video_ids) == 1 and video_ids[0]:
            return "video", video_ids[0]
    if len(parts) == 2 and parts[0] in {"embed", "live", "shorts"}:
        return "video", parts[1]
    raise ValueError("Use a YouTube channel, handle, video, or youtu.be URL")


def resolve_youtube_channel(url: str, settings: Settings) -> dict[str, Any]:
    filter_name, filter_value = parse_channel_reference(url)
    client = YouTubeClient(settings.youtube_api_key)
    try:
        if filter_name == "video":
            videos = client._get("/videos", part="snippet", id=filter_value).get("items", [])
            if not videos:
                raise ValueError("YouTube video was not found")
            channel_id = videos[0].get("snippet", {}).get("channelId")
            if not channel_id:
                raise ValueError("The video's channel could not be identified")
            filter_name, filter_value = "id", channel_id
        data = client._get(
            "/channels",
            part="snippet,contentDetails,statistics",
            **{filter_name: filter_value},
        )
    finally:
        client.close()
    items = data.get("items", [])
    if not items:
        raise ValueError("YouTube channel was not found")
    item = items[0]
    snippet = item.get("snippet", {})
    thumbnails = snippet.get("thumbnails", {})
    thumbnail = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}
    statistics = item.get("statistics", {})
    channel_id = item["id"]
    return {
        "youtube_channel_id": channel_id,
        "name": snippet.get("title") or channel_id,
        "url": f"https://www.youtube.com/channel/{channel_id}",
        "thumbnail_url": thumbnail.get("url"),
        "description": snippet.get("description", ""),
        "uploads_playlist_id": item.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads"),
        "subscriber_count": _optional_int(statistics.get("subscriberCount")),
        "public_video_count": _optional_int(statistics.get("videoCount")),
        "video_count": _optional_int(statistics.get("videoCount")),
    }


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _audit(
    conn: Connection,
    *,
    action: str,
    target_id: UUID,
    user_id: UUID,
    actor: str | None,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    outcome: str = "success",
    error: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO admin_audit_events
            (id, action, target_type, target_id, user_id, actor, before_values,
             after_values, outcome, error_message)
        VALUES (%s, %s, 'tracked_channel', %s, %s, %s, %s, %s, %s, %s)
        """,
        (uuid4(), action, target_id, user_id, actor, Jsonb(before or {}), Jsonb(after or {}), outcome, error),
    )


def upsert_admin_channel(
    conn: Connection,
    *,
    user_id: UUID | None,
    details: dict[str, Any],
    max_video_age_days: int,
    actor: str | None,
    commit: bool = True,
) -> tuple[dict[str, Any], bool]:
    user_id = resolve_admin_owner(conn, user_id)
    existing = conn.execute(
        "SELECT * FROM tracked_channels WHERE youtube_channel_id = %s FOR UPDATE",
        (details["youtube_channel_id"],),
    ).fetchone()
    if existing and existing["user_id"] != user_id:
        raise HTTPException(
            status_code=409,
            detail="That YouTube channel is already owned; shared channel ownership is not supported",
        )
    if existing and existing["is_active"]:
        raise HTTPException(status_code=409, detail="That channel is already actively tracked")
    if existing:
        before = {"is_active": False, "max_video_age_days": existing["max_video_age_days"]}
        row = conn.execute(
            """
            UPDATE tracked_channels
            SET is_active = TRUE, max_video_age_days = %s, name = %s, url = %s,
                thumbnail_url = %s, description = %s, uploads_playlist_id = %s,
                subscriber_count = %s, public_video_count = %s, metadata_updated_at = NOW(),
                backfill_completed_at = CASE
                    WHEN max_video_age_days < %s THEN NULL ELSE backfill_completed_at END
            WHERE id = %s RETURNING *
            """,
            (
                max_video_age_days, details["name"], details["url"], details["thumbnail_url"],
                details["description"], details["uploads_playlist_id"], details["subscriber_count"],
                details["public_video_count"], max_video_age_days, existing["id"],
            ),
        ).fetchone()
        _audit(
            conn, action="reactivate", target_id=existing["id"], user_id=user_id, actor=actor,
            before=before, after={"is_active": True, "max_video_age_days": max_video_age_days},
        )
        if commit:
            conn.commit()
        return row, True
    channel_id = uuid4()
    row = conn.execute(
        """
        INSERT INTO tracked_channels
            (id, user_id, youtube_channel_id, name, url, uploads_playlist_id, is_active,
             max_video_age_days, thumbnail_url, description, subscriber_count,
             public_video_count, metadata_updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, TRUE, %s, %s, %s, %s, %s, NOW())
        RETURNING *
        """,
        (
            channel_id, user_id, details["youtube_channel_id"], details["name"], details["url"],
            details["uploads_playlist_id"], max_video_age_days, details["thumbnail_url"],
            details["description"], details["subscriber_count"], details["public_video_count"],
        ),
    ).fetchone()
    _audit(
        conn, action="add", target_id=channel_id, user_id=user_id, actor=actor,
        before=None, after={"is_active": True, "max_video_age_days": max_video_age_days},
    )
    if commit:
        conn.commit()
    return row, False


def resolve_admin_owner(conn: Connection, requested_user_id: UUID | None) -> UUID:
    if requested_user_id is not None:
        owner = conn.execute("SELECT id FROM app_users WHERE id = %s", (requested_user_id,)).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Owner not found")
        return owner["id"]
    owners = conn.execute("SELECT id FROM app_users ORDER BY created_at, id LIMIT 2").fetchall()
    if not owners:
        raise HTTPException(status_code=404, detail="No owner is configured")
    if len(owners) > 1:
        raise HTTPException(status_code=409, detail="Select an owner when multiple app users exist")
    return owners[0]["id"]


def delivery_state(delivered_at: datetime | None) -> Literal["queued", "delivered"]:
    return "delivered" if delivered_at is not None else "queued"


def _page(items: list[dict[str, Any]], total: int, page: int, page_size: int) -> dict[str, Any]:
    return {"items": items, "page": page, "page_size": page_size, "total": total}


@router.get("/summary")
def summary(conn: Connection = Depends(connection)):
    return conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM tracked_channels WHERE is_active) AS active_channels,
            (SELECT COUNT(*) FROM videos) AS video_count,
            (SELECT COUNT(*) FROM recommendations) AS recommendation_count,
            (SELECT COUNT(*) FROM recommendations WHERE delivered_at IS NULL) AS queued_recommendation_count,
            (SELECT COUNT(*) FROM recommendations WHERE delivered_at IS NOT NULL) AS delivered_recommendation_count,
            latest.status AS latest_ingestion_status,
            COALESCE(latest.completed_at, latest.started_at) AS latest_ingestion_at,
            latest.error_message AS latest_ingestion_error
            ,(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.display_name)
                                        ORDER BY u.display_name), '[]'::jsonb)
              FROM app_users u) AS owner_options
            ,(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                                        ORDER BY c.name), '[]'::jsonb)
              FROM tracked_channels c WHERE c.is_active) AS channels
        FROM (SELECT status, started_at, completed_at, error_message
              FROM ingestion_runs ORDER BY started_at DESC LIMIT 1) latest
        RIGHT JOIN (SELECT 1) singleton ON TRUE
        """
    ).fetchone()


@router.get("/activity")
def activity(limit: int = Query(default=30, ge=1, le=100), conn: Connection = Depends(connection)):
    return conn.execute(
        """
        SELECT * FROM (
            SELECT started_at AS created_at, 'ingestion' AS event_type, id AS target_id,
                   status AS result, error_message AS error, NULL::jsonb AS details,
                   id::text AS affected_record
            FROM ingestion_runs
            UNION ALL
            SELECT created_at, action, target_id, outcome, error_message,
                   jsonb_build_object('before', before_values, 'after', after_values) AS details,
                   target_id::text
            FROM admin_audit_events
            UNION ALL
            SELECT created_at, event_type, COALESCE(recommendation_id, user_id), source, NULL,
                   metadata AS details, COALESCE(recommendation_id, user_id)::text
            FROM interaction_events
        ) events ORDER BY created_at DESC LIMIT %s
        """,
        (limit,),
    ).fetchall()


@router.get("/channels")
def channels(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
    include_inactive: bool = False,
    search: str | None = Query(default=None, max_length=200),
    sort: Literal[
        "name", "created_at", "created_at_desc", "last_sync_started_at",
        "last_ingestion_at_desc", "latest_video_published_at"
    ] = "name",
    direction: Literal["asc", "desc"] = "asc",
    conn: Connection = Depends(connection),
):
    filters: list[str] = [] if include_inactive else ["c.is_active"]
    params: list[Any] = []
    if search and search.strip():
        filters.append("(c.name ILIKE %s OR u.display_name ILIKE %s OR c.youtube_channel_id ILIKE %s)")
        term = f"%{search.strip()}%"
        params.extend([term, term, term])
    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    total = conn.execute(
        f"SELECT COUNT(*) AS count FROM tracked_channels c JOIN app_users u ON u.id = c.user_id {where}",
        params,
    ).fetchone()["count"]
    sort_sql = {
        "name": "c.name", "created_at": "c.created_at", "last_sync_started_at": "c.last_sync_started_at",
        "latest_video_published_at": "latest_video_published_at", "created_at_desc": "c.created_at",
        "last_ingestion_at_desc": "c.last_sync_completed_at",
    }[sort]
    effective_direction = "desc" if sort.endswith("_desc") else direction
    rows = conn.execute(
        f"""
        SELECT c.*, u.display_name AS owner_name, COUNT(v.id) AS ingested_video_count,
               MAX(v.published_at) AS latest_video_published_at, COUNT(v.id) AS video_count,
               MAX(v.ingested_at) AS latest_video_ingested_at
        FROM tracked_channels c
        JOIN app_users u ON u.id = c.user_id
        LEFT JOIN videos v ON v.tracked_channel_id = c.id
        {where}
        GROUP BY c.id, u.display_name
        ORDER BY {sort_sql} {effective_direction.upper()} NULLS LAST, c.id ASC
        LIMIT %s OFFSET %s
        """,
        [*params, page_size, (page - 1) * page_size],
    ).fetchall()
    return _page(rows, total, page, page_size)


@router.post("/channels/resolve")
def resolve_channel(payload: ChannelUrl, settings: Settings = Depends(get_settings)):
    if not settings.youtube_api_key:
        raise HTTPException(status_code=503, detail="YouTube resolver is not configured")
    try:
        return resolve_youtube_channel(str(payload.url), settings)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="YouTube channel resolution failed") from exc


@router.post("/channels", status_code=status.HTTP_201_CREATED)
def add_channel(
    payload: ChannelCreate,
    claims: dict[str, Any] = Depends(require_admin),
    settings: Settings = Depends(get_settings),
    conn: Connection = Depends(connection),
):
    if not settings.youtube_api_key:
        raise HTTPException(status_code=503, detail="YouTube resolver is not configured")
    try:
        details = resolve_youtube_channel(str(payload.url), settings)
        row, reactivated = upsert_admin_channel(
            conn, user_id=payload.user_id, details=details,
            max_video_age_days=payload.max_video_age_days, actor=claims.get("sub"),
        )
    except HTTPException:
        conn.rollback()
        raise
    except UniqueViolation as exc:
        conn.rollback()
        raise HTTPException(status_code=409, detail="That channel is already actively tracked") from exc
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        conn.rollback()
        raise HTTPException(status_code=502, detail="YouTube channel resolution failed") from exc
    return {**row, "reactivated": reactivated}


@router.get("/channels/{channel_id}")
def channel_detail(channel_id: UUID, conn: Connection = Depends(connection)):
    row = conn.execute(
        """
        SELECT c.*, u.display_name AS owner_name, COUNT(v.id) AS video_count,
               MAX(v.published_at) AS latest_video_published_at,
               MAX(v.ingested_at) AS latest_video_ingested_at
        FROM tracked_channels c JOIN app_users u ON u.id = c.user_id
        LEFT JOIN videos v ON v.tracked_channel_id = c.id
        WHERE c.id = %s GROUP BY c.id, u.display_name
        """,
        (channel_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Channel not found")
    return row


@router.patch("/channels/{channel_id}")
def patch_channel(
    channel_id: UUID,
    payload: ChannelPatch,
    claims: dict[str, Any] = Depends(require_admin),
    conn: Connection = Depends(connection),
):
    current = conn.execute("SELECT * FROM tracked_channels WHERE id = %s FOR UPDATE", (channel_id,)).fetchone()
    if not current:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Channel not found")
    if payload.is_active is not None:
        if current["is_active"] == payload.is_active:
            conn.rollback()
            return current
        field, value = "is_active", payload.is_active
        action = "restore" if value else "stop"
        extra = ""
    else:
        field, value = "max_video_age_days", payload.max_video_age_days
        action = "change_max_video_age"
        extra = ", backfill_completed_at = CASE WHEN max_video_age_days < %s THEN NULL ELSE backfill_completed_at END"
    query_params: list[Any] = [value]
    if extra:
        query_params.append(value)
    query_params.append(channel_id)
    row = conn.execute(
        f"UPDATE tracked_channels SET {field} = %s{extra} WHERE id = %s RETURNING *",
        query_params,
    ).fetchone()
    _audit(
        conn, action=action, target_id=channel_id, user_id=current["user_id"], actor=claims.get("sub"),
        before={field: current[field]}, after={field: value},
    )
    conn.commit()
    return row


@router.get("/videos")
def videos(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
    search: str | None = Query(default=None, max_length=200),
    channel_id: UUID | None = None,
    published_from: datetime | None = None,
    published_after: datetime | None = None,
    published_to: datetime | None = None,
    ingested_from: datetime | None = None,
    ingested_after: datetime | None = None,
    ingested_to: datetime | None = None,
    embedding: Literal["present", "missing"] | None = None,
    embedding_model: str | None = Query(default=None, max_length=120),
    has_recommendations: bool | None = None,
    sort: Literal[
        "published_at", "published_at_desc", "ingested_at", "ingested_at_desc",
        "title", "title_asc", "view_count", "view_count_desc"
    ] = "published_at",
    direction: Literal["asc", "desc"] = "desc",
    conn: Connection = Depends(connection),
):
    if published_from and published_after and published_from != published_after:
        raise HTTPException(status_code=422, detail="Use only one publication start filter")
    if ingested_from and ingested_after and ingested_from != ingested_after:
        raise HTTPException(status_code=422, detail="Use only one ingestion start filter")
    publication_start = published_from or published_after
    ingestion_start = ingested_from or ingested_after
    filters: list[str] = []
    params: list[Any] = []
    if search and search.strip():
        filters.append("(v.title ILIKE %s OR v.channel_name ILIKE %s OR v.description ILIKE %s)")
        term = f"%{search.strip()}%"
        params.extend([term, term, term])
    for column, value, operator in (
        ("v.tracked_channel_id", channel_id, "="), ("v.published_at", publication_start, ">="),
        ("v.published_at", published_to, "<="), ("v.ingested_at", ingestion_start, ">="),
        ("v.ingested_at", ingested_to, "<="), ("v.semantic_embedding_model", embedding_model, "="),
    ):
        if value is not None:
            filters.append(f"{column} {operator} %s")
            params.append(value)
    if embedding:
        filters.append(f"v.semantic_embedding IS {'NOT ' if embedding == 'present' else ''}NULL")
    if has_recommendations is not None:
        filters.append(
            f"{'EXISTS' if has_recommendations else 'NOT EXISTS'} "
            "(SELECT 1 FROM recommendations rx WHERE rx.video_id = v.id)"
        )
    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    total = conn.execute(f"SELECT COUNT(*) AS count FROM videos v {where}", params).fetchone()["count"]
    sort_sql = {
        "published_at": "v.published_at", "published_at_desc": "v.published_at",
        "ingested_at": "v.ingested_at", "ingested_at_desc": "v.ingested_at",
        "title": "v.title", "title_asc": "v.title",
        "view_count": "v.view_count", "view_count_desc": "v.view_count",
    }[sort]
    effective_direction = "asc" if sort.endswith("_asc") else "desc" if sort.endswith("_desc") else direction
    rows = conn.execute(
        f"""
        SELECT v.id, v.youtube_video_id, v.tracked_channel_id, v.channel_name, v.title,
               v.speaker, v.youtube_url, v.thumbnail_url, v.published_at, v.ingested_at,
               v.updated_at, v.duration_seconds, v.view_count, v.content_fingerprint,
               v.semantic_embedding_model AS embedding_model,
               v.semantic_embedding_revision AS embedding_revision,
               v.semantic_embedding_dimensions AS embedding_dimensions,
               v.semantic_embedding IS NOT NULL AS has_embedding,
               COUNT(r.id) AS recommendation_count
        FROM videos v LEFT JOIN recommendations r ON r.video_id = v.id
        {where} GROUP BY v.id
        ORDER BY {sort_sql} {effective_direction.upper()} NULLS LAST, v.id ASC LIMIT %s OFFSET %s
        """,
        [*params, page_size, (page - 1) * page_size],
    ).fetchall()
    return _page(rows, total, page, page_size)


@router.get("/videos/{video_id}")
def video_detail(video_id: UUID, conn: Connection = Depends(connection)):
    row = conn.execute(
        """
        SELECT v.id, v.youtube_video_id, v.tracked_channel_id, v.channel_name, v.title,
               v.speaker, v.youtube_url, v.thumbnail_url, v.description, v.published_at,
               v.ingested_at, v.updated_at, v.duration_seconds, v.view_count,
               v.channel_baseline_views, v.content_fingerprint,
               v.semantic_embedding_model AS embedding_model,
               v.semantic_embedding_revision AS embedding_revision,
               v.semantic_embedding_dimensions AS embedding_dimensions,
               v.semantic_embedding_fingerprint AS embedding_fingerprint,
               v.semantic_embedding_attempt_count AS embedding_attempt_count,
               v.semantic_embedding_last_attempt_at AS embedding_last_attempt_at,
               v.semantic_embedding_last_error AS embedding_last_error,
               v.semantic_embedding IS NOT NULL AS has_embedding,
               (SELECT COUNT(*) FROM recommendations r WHERE r.video_id = v.id) AS recommendation_count
        FROM videos v WHERE v.id = %s
        """,
        (video_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Video not found")
    return row


@router.post("/videos/vector-search")
def vector_search(
    payload: VectorSearch,
    conn: Connection = Depends(connection),
    settings: Settings = Depends(get_settings),
):
    encoder = configured_embedder(settings)
    if payload.model is not None and payload.model != encoder.model_name:
        raise HTTPException(status_code=422, detail=f"No compatible encoder for embedding model {payload.model}")
    query_vectors = encoder.embed_queries([payload.phrase])
    if len(query_vectors) != 1 or len(query_vectors[0]) != encoder.dimensions:
        raise HTTPException(status_code=500, detail="Vector encoder dimension mismatch")
    query_vector = "[" + ",".join(format(float(value), ".17g") for value in query_vectors[0]) + "]"
    conn.execute("SET LOCAL hnsw.iterative_scan = strict_order")
    conn.execute("SET LOCAL hnsw.ef_search = 100")
    rows = conn.execute(
        """
        SELECT id, youtube_video_id, tracked_channel_id, channel_name, title, speaker,
               youtube_url, thumbnail_url, published_at, ingested_at, duration_seconds,
               view_count, semantic_embedding_model AS embedding_model,
               semantic_embedding_revision AS embedding_revision,
               semantic_embedding_dimensions AS embedding_dimensions,
               1 - (semantic_embedding <=> %s::vector) AS similarity,
               1 - (semantic_embedding <=> %s::vector) AS similarity_score
        FROM videos
        WHERE semantic_embedding IS NOT NULL
          AND semantic_embedding_model = %s
          AND semantic_embedding_revision = %s
          AND semantic_embedding_dimensions = %s
          AND semantic_embedding_fingerprint IS NOT DISTINCT FROM content_fingerprint
        ORDER BY semantic_embedding <=> %s::vector, id
        LIMIT %s
        """,
        (
            query_vector,
            query_vector,
            encoder.model_name,
            encoder.model_revision,
            encoder.dimensions,
            query_vector,
            payload.limit,
        ),
    ).fetchall()
    if not rows:
        raise HTTPException(status_code=409, detail="No compatible stored vectors are available")
    return {
        "model": encoder.model_name,
        "revision": encoder.model_revision,
        "dimensions": encoder.dimensions,
        "items": rows,
    }


@router.get("/recommendations")
def recommendations(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
    search: str | None = Query(default=None, max_length=200),
    delivery: Literal["queued", "delivered"] | None = None,
    delivery_state: Literal["queued", "delivered"] | None = None,
    rating: Literal["up", "down", "unrated"] | None = None,
    sort: Literal[
        "created_at", "created_at_desc", "created_at_asc", "delivered_at",
        "delivered_at_desc", "clicked_at", "rating"
    ] = "created_at",
    direction: Literal["asc", "desc"] = "desc",
    conn: Connection = Depends(connection),
):
    if delivery and delivery_state and delivery != delivery_state:
        raise HTTPException(status_code=422, detail="Use only one delivery-state filter")
    effective_delivery = delivery or delivery_state
    filters: list[str] = []
    params: list[Any] = []
    if search and search.strip():
        filters.append("(v.title ILIKE %s OR v.channel_name ILIKE %s OR r.rationale ILIKE %s OR u.display_name ILIKE %s)")
        term = f"%{search.strip()}%"
        params.extend([term, term, term, term])
    if effective_delivery:
        filters.append(f"r.delivered_at IS {'NOT ' if effective_delivery == 'delivered' else ''}NULL")
    if rating:
        if rating == "unrated":
            filters.append("r.rating IS NULL")
        else:
            filters.append("r.rating = %s")
            params.append(rating)
    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    joins = "FROM recommendations r JOIN videos v ON v.id = r.video_id JOIN app_users u ON u.id = r.user_id"
    total = conn.execute(f"SELECT COUNT(*) AS count {joins} {where}", params).fetchone()["count"]
    sort_sql = {
        "created_at": "r.created_at", "created_at_desc": "r.created_at", "created_at_asc": "r.created_at",
        "delivered_at": "r.delivered_at", "delivered_at_desc": "r.delivered_at",
        "clicked_at": "r.clicked_at", "rating": "r.rating",
    }[sort]
    effective_direction = "asc" if sort.endswith("_asc") else "desc" if sort.endswith("_desc") else direction
    rows = conn.execute(
        f"""
        SELECT r.id, r.user_id, u.display_name AS recipient_name,
               u.telegram_user_id, r.video_id, v.title AS video_title, v.channel_name,
               v.youtube_url, v.thumbnail_url, r.rationale, r.rating, r.clicked_at,
               r.delivered_at, r.created_at,
               CASE WHEN r.delivered_at IS NULL THEN 'queued' ELSE 'delivered' END AS delivery_state
        {joins} {where}
        ORDER BY {sort_sql} {effective_direction.upper()} NULLS LAST, r.id ASC LIMIT %s OFFSET %s
        """,
        [*params, page_size, (page - 1) * page_size],
    ).fetchall()
    return _page(rows, total, page, page_size)


@router.get("/recommendations/{recommendation_id}")
def recommendation_detail(recommendation_id: UUID, conn: Connection = Depends(connection)):
    row = conn.execute(
        """
        SELECT r.*, CASE WHEN r.delivered_at IS NULL THEN 'queued' ELSE 'delivered' END AS delivery_state,
               to_jsonb(v) AS video, to_jsonb(u) - 'created_at' - 'updated_at' AS recipient,
               COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                         FROM interaction_events e WHERE e.recommendation_id = r.id), '[]'::jsonb) AS events
        FROM recommendations r JOIN videos v ON v.id = r.video_id
        JOIN app_users u ON u.id = r.user_id WHERE r.id = %s
        """,
        (recommendation_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    return row
