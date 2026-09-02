from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from psycopg import Connection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from backend.app.db import close_pool, connection, open_pool
from backend.app.ranking import Candidate, rank_candidate
from backend.app.schemas import Channel, ChannelCreate, FeedbackCreate, Metrics, Profile, ProfileUpdate, Recommendation
from backend.app.settings import get_settings

USER_ID = UUID("00000000-0000-0000-0000-000000000001")


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


settings = get_settings()
app = FastAPI(title="Finite Feed API", version="0.1.0", lifespan=lifespan)
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
def ready(conn: Connection = Depends(connection)) -> dict[str, str | int]:
    migration_count = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()
    return {"status": "ready", "commit": settings.app_commit_sha, "migrations": migration_count["count"]}


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


@app.get("/api/channels", response_model=list[Channel])
def list_channels(conn: Connection = Depends(connection)):
    return conn.execute(
        "SELECT id, name, url, is_default, created_at FROM tracked_channels WHERE user_id = %s ORDER BY is_default DESC, name",
        (USER_ID,),
    ).fetchall()


@app.post("/api/channels", response_model=Channel, status_code=status.HTTP_201_CREATED)
def add_channel(payload: ChannelCreate, conn: Connection = Depends(connection)):
    try:
        row = conn.execute(
            "INSERT INTO tracked_channels (id, user_id, name, url) VALUES (%s, %s, %s, %s) RETURNING id, name, url, is_default, created_at",
            (uuid4(), USER_ID, payload.name, str(payload.url)),
        ).fetchone()
        conn.execute(
            "INSERT INTO interaction_events (id, user_id, event_type, source, metadata) VALUES (%s, %s, 'channel_add', 'dashboard', %s)",
            (uuid4(), USER_ID, Jsonb({"url": str(payload.url)})),
        )
        conn.commit()
        return row
    except UniqueViolation as exc:
        conn.rollback()
        raise HTTPException(status_code=409, detail="That channel is already tracked") from exc


@app.delete("/api/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_channel(channel_id: UUID, conn: Connection = Depends(connection)) -> Response:
    row = conn.execute(
        "DELETE FROM tracked_channels WHERE id = %s AND user_id = %s RETURNING url",
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
    profile = profile_row(conn)
    rows = conn.execute(
        """
        SELECT id, title, description, view_count, channel_baseline_views, published_at
        FROM videos
        WHERE published_at IS NOT NULL
          AND id NOT IN (SELECT video_id FROM recommendations WHERE user_id = %s)
        ORDER BY published_at DESC LIMIT 50
        """,
        (USER_ID,),
    ).fetchall()
    if not rows:
        raise HTTPException(status_code=409, detail="No unsent videos are available. Configure YouTube ingestion first.")
    scored = []
    for row in rows:
        candidate = Candidate(
            str(row["id"]), row["title"], row["description"], row["view_count"],
            row["channel_baseline_views"], row["published_at"],
        )
        score, evidence = rank_candidate(candidate, profile["preference_statement"])
        scored.append((score, evidence, row))
    score, evidence, selected = max(scored, key=lambda item: item[0])
    rationale = f"This talk best matches your current preferences, with a baseline relevance score of {score:.2f}."
    conn.execute(
        "INSERT INTO recommendations (id, user_id, video_id, rationale, evidence) VALUES (%s, %s, %s, %s, %s)",
        (uuid4(), USER_ID, selected["id"], rationale, Jsonb(evidence)),
    )
    conn.commit()
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
    return conn.execute(RECOMMENDATION_SELECT + " LIMIT 1", (USER_ID,)).fetchone()


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
