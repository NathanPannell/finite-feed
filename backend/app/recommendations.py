import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.embeddings import MODEL_NAME, cosine_similarity, embed_text
from backend.app.openrouter import OpenRouterClient
from backend.app.settings import Settings


@dataclass(frozen=True)
class ScoredVideo:
    row: dict
    relevance: float
    momentum: float
    score: float
    pool: str = "evergreen"


def _momentum(view_count: int, baseline: int, published_at: datetime | None, now: datetime) -> float:
    if not published_at:
        return 0.0
    age_days = max((now - published_at).total_seconds() / 86400, 1.0)
    return min(math.log1p(view_count / max(baseline, 1)) / math.sqrt(age_days), 1.0)


def retrieve_shortlist(rows: list[dict], preference: str, since: datetime | None, now: datetime | None = None) -> list[ScoredVideo]:
    current_time = now or datetime.now(UTC)
    preference_vector = embed_text(preference)
    scored: list[ScoredVideo] = []
    for row in rows:
        relevance = max(cosine_similarity(preference_vector, list(row["embedding"])), 0.0)
        momentum = _momentum(row["view_count"], row["channel_baseline_views"], row["published_at"], current_time)
        scored.append(ScoredVideo(row, relevance, momentum, relevance * 0.72 + momentum * 0.28))
    recent_cutoff = since or current_time - timedelta(days=14)
    recent = sorted(
        (item for item in scored if item.row["published_at"] and item.row["published_at"] >= recent_cutoff),
        key=lambda item: item.score, reverse=True,
    )[:5]
    recent_ids = {item.row["id"] for item in recent}
    evergreen = sorted((item for item in scored if item.row["id"] not in recent_ids), key=lambda item: item.score, reverse=True)[:10]
    return [ScoredVideo(item.row, item.relevance, item.momentum, item.score, "recent") for item in recent] + evergreen


def generate_recommendation(conn: Connection, settings: Settings, user_id: UUID, require_model: bool = False) -> UUID:
    profile = conn.execute(
        "SELECT preference_statement FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if not profile:
        raise ValueError("Profile not found")
    rows = conn.execute(
        """
        SELECT id, youtube_video_id, title, description, speaker, channel_name, published_at,
               view_count, channel_baseline_views, embedding
        FROM videos
        WHERE embedding IS NOT NULL AND embedding_model = %s
          AND id NOT IN (SELECT video_id FROM recommendations WHERE user_id = %s)
        """,
        (MODEL_NAME, user_id),
    ).fetchall()
    if not rows:
        raise ValueError("No embedded, unsent videos are available")
    last_delivery = conn.execute(
        "SELECT MAX(delivered_at) AS delivered_at FROM recommendations WHERE user_id = %s",
        (user_id,),
    ).fetchone()["delivered_at"]
    shortlist = retrieve_shortlist(rows, profile["preference_statement"], last_delivery)
    if not shortlist:
        raise ValueError("No eligible videos are available")
    model_candidates = [{
        "video_id": item.row["youtube_video_id"],
        "title": item.row["title"],
        "speaker": item.row["speaker"],
        "channel": item.row["channel_name"],
        "description": item.row["description"][:1200],
        "published_at": item.row["published_at"],
        "semantic_relevance": round(item.relevance, 4),
        "relative_momentum": round(item.momentum, 4),
        "candidate_pool": item.pool,
    } for item in shortlist]
    choice = None
    model_error = None
    if settings.openrouter_api_key:
        client = OpenRouterClient(
            settings.openrouter_api_key, settings.openrouter_model,
            settings.openrouter_base_url, settings.public_app_url,
        )
        try:
            choice = client.choose(profile["preference_statement"], model_candidates)
        except Exception as exc:
            model_error = f"{type(exc).__name__}: {exc}"
            if require_model:
                raise
        finally:
            client.close()
    elif require_model:
        raise ValueError("OPENROUTER_API_KEY is required")
    selected = next(
        (item for item in shortlist if choice and item.row["youtube_video_id"] == choice.video_id),
        max(shortlist, key=lambda item: item.score),
    )
    rationale = choice.rationale if choice else (
        f"This talk is the strongest current match for your profile. Its retrieval score combines "
        f"{selected.relevance:.0%} vector relevance with age-normalized momentum."
    )
    evidence = {
        "pipeline": "vector-retrieval-openrouter-rerank-v1",
        "embedding_model": MODEL_NAME,
        "reranker_model": choice.model if choice else None,
        "reranker_fallback": choice is None,
        "reranker_error": model_error,
        "selected_pool": selected.pool,
        "semantic_relevance": round(selected.relevance, 4),
        "age_normalized_momentum": round(selected.momentum, 4),
        "shortlist_size": len(shortlist),
        "candidate_video_ids": [item.row["youtube_video_id"] for item in shortlist],
    }
    recommendation_id = uuid4()
    conn.execute(
        "INSERT INTO recommendations (id, user_id, video_id, rationale, evidence) VALUES (%s, %s, %s, %s, %s)",
        (recommendation_id, user_id, selected.row["id"], rationale, Jsonb(evidence)),
    )
    conn.commit()
    return recommendation_id


def get_or_create_pending_recommendation(
    conn: Connection, settings: Settings, user_id: UUID, require_model: bool = False,
) -> UUID:
    pending = conn.execute(
        """
        SELECT id FROM recommendations
        WHERE user_id = %s AND delivered_at IS NULL
          AND (NOT %s OR evidence->>'reranker_fallback' = 'false')
        ORDER BY created_at LIMIT 1
        """,
        (user_id, require_model),
    ).fetchone()
    if pending:
        return pending["id"]
    return generate_recommendation(conn, settings, user_id, require_model)


def lock_recommendation_for_delivery(conn: Connection, user_id: UUID, recommendation_id: UUID) -> bool:
    row = conn.execute(
        "SELECT delivered_at FROM recommendations WHERE id = %s AND user_id = %s FOR UPDATE",
        (recommendation_id, user_id),
    ).fetchone()
    return bool(row and row["delivered_at"] is None)


def mark_recommendation_delivered(conn: Connection, user_id: UUID, recommendation_id: UUID, scheduled: bool) -> None:
    conn.execute(
        "UPDATE recommendations SET delivered_at = COALESCE(delivered_at, NOW()) WHERE id = %s AND user_id = %s",
        (recommendation_id, user_id),
    )
    conn.execute(
        """
        INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source, metadata)
        VALUES (gen_random_uuid(), %s, %s, 'delivery', 'telegram', %s)
        ON CONFLICT DO NOTHING
        """,
        (user_id, recommendation_id, Jsonb({"scheduled": scheduled})),
    )
    conn.commit()
