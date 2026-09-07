import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.budgets import reserve_request
from backend.app.description_processing import DESCRIPTION_PROCESSING_VERSION, clean_description
from backend.app.embeddings import Embedder, configured_embedder
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


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(format(float(value), ".17g") for value in vector) + "]"


def semantic_backfill_remaining(conn: Connection, embedder: Embedder) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS count
        FROM videos
        WHERE semantic_embedding IS NULL
           OR semantic_embedding_model IS DISTINCT FROM %s
           OR semantic_embedding_revision IS DISTINCT FROM %s
           OR semantic_embedding_dimensions IS DISTINCT FROM %s
           OR semantic_embedding_fingerprint IS DISTINCT FROM (%s || ':' || content_fingerprint)
        """,
        (
            embedder.model_name,
            embedder.model_revision,
            embedder.dimensions,
            DESCRIPTION_PROCESSING_VERSION,
        ),
    ).fetchone()
    return row["count"]


def _nearest_rows(
    conn: Connection,
    embedder: Embedder,
    user_id: UUID,
    query_vector: str,
    published_since: datetime | None,
    exclude_ids: list[UUID],
    limit: int,
) -> list[dict]:
    return conn.execute(
        """
        SELECT id, youtube_video_id, title, description, speaker, channel_name, published_at,
               view_count, channel_baseline_views,
               1 - (semantic_embedding <=> %s::vector) AS semantic_similarity
        FROM videos
        WHERE semantic_embedding IS NOT NULL
          AND semantic_embedding_model = %s
          AND semantic_embedding_revision = %s
          AND semantic_embedding_dimensions = %s
          AND semantic_embedding_fingerprint IS NOT DISTINCT FROM (%s || ':' || content_fingerprint)
          AND id NOT IN (SELECT video_id FROM recommendations WHERE user_id = %s)
          AND is_available = TRUE
          AND (COALESCE(default_audio_language, default_language, 'en') ~* '^en(-|$)')
          AND EXISTS (SELECT 1 FROM tracked_channels c JOIN user_channel_follows f ON f.channel_id = c.id
                      WHERE c.id = videos.tracked_channel_id AND c.is_active AND f.user_id = %s)
          AND (%s::timestamptz IS NULL OR published_at >= %s::timestamptz)
          AND (cardinality(%s::uuid[]) = 0 OR id <> ALL(%s::uuid[]))
        ORDER BY semantic_embedding <=> %s::vector
        LIMIT %s
        """,
        (
            query_vector,
            embedder.model_name,
            embedder.model_revision,
            embedder.dimensions,
            DESCRIPTION_PROCESSING_VERSION,
            user_id,
            user_id,
            published_since,
            published_since,
            exclude_ids,
            exclude_ids,
            query_vector,
            limit,
        ),
    ).fetchall()


def _score_rows(rows: list[dict], now: datetime, pool: str, take: int) -> list[ScoredVideo]:
    scored = []
    for row in rows:
        relevance = float(row["semantic_similarity"])
        momentum = _momentum(row["view_count"], row["channel_baseline_views"], row["published_at"], now)
        scored.append(ScoredVideo(row, relevance, momentum, relevance * 0.72 + momentum * 0.28, pool))
    ranked = sorted(scored, key=lambda item: item.score, reverse=True)
    selected = ranked[:take]
    if scored and take > 0:
        semantic_best = max(scored, key=lambda item: item.relevance)
        if semantic_best not in selected:
            selected[-1] = semantic_best
    return selected


def cosine_fallback(shortlist: list[ScoredVideo]) -> ScoredVideo:
    """Return the nearest semantic result without momentum or feedback influence."""
    return max(shortlist, key=lambda item: item.relevance)


def retrieve_shortlist(
    conn: Connection,
    settings: Settings,
    user_id: UUID,
    preference: str,
    since: datetime | None,
    now: datetime | None = None,
    embedder: Embedder | None = None,
) -> list[ScoredVideo]:
    current_time = now or datetime.now(UTC)
    encoder = embedder or configured_embedder(settings)
    conn.execute("SET LOCAL hnsw.iterative_scan = strict_order")
    conn.execute("SET LOCAL hnsw.ef_search = 100")
    conn.execute("SET LOCAL hnsw.max_scan_tuples = 20000")
    query_vector = _vector_literal(encoder.embed_queries([preference.strip()])[0])
    recent_cutoff = since or current_time - timedelta(days=14)
    recent = _score_rows(
        _nearest_rows(conn, encoder, user_id, query_vector, recent_cutoff, [], 25),
        current_time,
        "recent",
        5,
    )
    evergreen = _score_rows(
        _nearest_rows(conn, encoder, user_id, query_vector, None, [item.row["id"] for item in recent], 50),
        current_time,
        "evergreen",
        10,
    )
    return [item for item in recent + evergreen if item.relevance >= settings.minimum_relevance]


def apply_feedback(shortlist: list[ScoredVideo], feedback: list[dict], encoder: Embedder) -> list[ScoredVideo]:
    if not feedback:
        return shortlist
    vectors = encoder.embed_documents([clean_description(row['description'])[:1200] or row['title'] for row in feedback])
    candidate_vectors = encoder.embed_documents([item.row['title'] + "\n" + clean_description(item.row['description'])[:1200] for item in shortlist])
    adjusted = []
    for item, vector in zip(shortlist, candidate_vectors):
        influence = sum((1 if row['rating'] == 'up' else -1) * max(0, sum(a*b for a,b in zip(vector, old))) for row, old in zip(feedback, vectors)) / len(feedback)
        adjusted.append(ScoredVideo(item.row, item.relevance, item.momentum, item.score + 0.12 * influence, item.pool))
    return sorted(adjusted, key=lambda item: item.score, reverse=True)


def generate_recommendation(
    conn: Connection,
    settings: Settings,
    user_id: UUID,
    require_model: bool = False,
    embedder: Embedder | None = None,
    expected_preference_version_id: UUID | None = None,
) -> UUID:
    profile = conn.execute(
        "SELECT id, preference_statement FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if not profile:
        raise ValueError("Profile not found")
    if expected_preference_version_id is not None and profile["id"] != expected_preference_version_id:
        raise ValueError("Your preferences changed. Please request a new recommendation.")
    last_delivery = conn.execute(
        "SELECT MAX(delivered_at) AS delivered_at FROM recommendations WHERE user_id = %s",
        (user_id,),
    ).fetchone()["delivered_at"]
    encoder = embedder or configured_embedder(settings)
    shortlist = retrieve_shortlist(
        conn, settings, user_id, profile["preference_statement"], last_delivery, embedder=encoder
    )
    if not shortlist:
        raise ValueError("No strong matches yet. Try broadening your interests or following another source.")
    feedback = conn.execute(
        """SELECT r.rating, v.title, v.description FROM recommendations r
        JOIN videos v ON v.id = r.video_id WHERE r.user_id = %s AND r.rating IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 20""", (user_id,),
    ).fetchall()
    # Bound learned influence; the written profile and explicit exclusions stay primary.
    feedback_text = "\n".join(f"{'More' if row['rating'] == 'up' else 'Less'} like: {row['title']}" for row in feedback)
    judge_profile = profile["preference_statement"]
    if feedback_text:
        judge_profile += "\n\nSecondary feedback (never override explicit preferences):\n" + feedback_text
        shortlist = apply_feedback(shortlist, feedback, encoder)
    model_candidates = [{
        "video_id": item.row["youtube_video_id"],
        "title": item.row["title"],
        "speaker": item.row["speaker"],
        "channel": item.row["channel_name"],
        "description": clean_description(item.row["description"])[:1200],
        "published_at": item.row["published_at"],
        "semantic_relevance": round(item.relevance, 4),
        "relative_momentum": round(item.momentum, 4),
        "candidate_pool": item.pool,
        "feedback_adjusted_score": round(item.score, 4),
    } for item in shortlist]
    choice = None
    model_error = None
    if settings.openrouter_api_key:
        try:
            reserve_request(conn, "openrouter", settings.model_daily_request_limit)
        except ValueError:
            model_error = "request_budget_exhausted"
        else:
            try:
                client = OpenRouterClient(
                    settings.openrouter_api_key, settings.openrouter_model,
                    settings.openrouter_base_url, settings.public_app_url,
                )
                try:
                    choice = client.choose(judge_profile, model_candidates)
                finally:
                    client.close()
            except Exception as exc:
                model_error = type(exc).__name__
    else:
        model_error = "missing_api_key"
    if choice and choice.video_id is None:
        raise ValueError("No strong match this time. Your preferences are saved; we will try again later.")
    selected = next(
        (item for item in shortlist if choice and item.row["youtube_video_id"] == choice.video_id),
        cosine_fallback(shortlist),
    )
    rationale = choice.rationale if choice else (
        f"This one is the nearest available match to your preferences by cosine similarity "
        f"({selected.relevance:.0%})."
    )
    evidence = {
        "feedback_count": len(feedback),
        "feedback_influence_limit": 0.12,
        "feedback_summary": feedback_text,
        "pipeline": "pgvector-cosine-openrouter-rerank-v2",
        "embedding_model": encoder.model_name,
        "embedding_revision": encoder.model_revision,
        "embedding_dimensions": encoder.dimensions,
        "reranker_model": choice.model if choice else None,
        "reranker_fallback": choice is None,
        "reranker_error": model_error,
        "selected_pool": selected.pool,
        "final_score": round(selected.score, 4),
        "feedback_delta": round(selected.score - (selected.relevance * 0.72 + selected.momentum * 0.28), 4),
        "candidate_scores": [{"video_id": item.row["youtube_video_id"], "score": round(item.score, 4)} for item in shortlist],
        "semantic_relevance": round(selected.relevance, 4),
        "age_normalized_momentum": round(selected.momentum, 4),
        "shortlist_size": len(shortlist),
        "candidate_video_ids": [item.row["youtube_video_id"] for item in shortlist],
    }
    # The provider reservation commits before its HTTP call. Reacquire the account
    # lock before writing so a completed deletion or preference change wins.
    account = conn.execute("SELECT deleted_at FROM app_users WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
    if not account or account["deleted_at"]:
        raise ValueError("Account is no longer active")
    current_profile = conn.execute(
        "SELECT id FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1", (user_id,),
    ).fetchone()
    if not current_profile or current_profile["id"] != profile["id"]:
        raise ValueError("Your preferences changed. Please request a new recommendation.")
    eligible = conn.execute(
        """SELECT v.id FROM videos v JOIN tracked_channels c ON c.id = v.tracked_channel_id
        JOIN user_channel_follows f ON f.channel_id = c.id
        WHERE v.id = %s AND f.user_id = %s AND c.is_active AND v.is_available
          AND COALESCE(v.default_audio_language, v.default_language, 'en') ~* '^en(-|$)'
        FOR SHARE OF v, c, f""", (selected.row["id"], user_id),
    ).fetchone()
    if not eligible:
        raise ValueError("Your sources changed. Please request a new recommendation.")
    recommendation_id = uuid4()
    conn.execute(
        """INSERT INTO recommendations
           (id, user_id, video_id, preference_version_id, rationale, evidence)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (recommendation_id, user_id, selected.row["id"], profile["id"], rationale, Jsonb(evidence)),
    )
    conn.commit()
    return recommendation_id


def get_or_create_pending_recommendation(
    conn: Connection, settings: Settings, user_id: UUID, require_model: bool = False,
) -> UUID:
    pending = conn.execute(
        """
        SELECT r.id FROM recommendations r JOIN videos v ON v.id = r.video_id
        JOIN tracked_channels c ON c.id = v.tracked_channel_id
        JOIN user_channel_follows f ON f.channel_id = c.id AND f.user_id = r.user_id
        WHERE r.user_id = %s AND delivered_at IS NULL AND c.is_active AND v.is_available
          AND COALESCE(v.default_audio_language, v.default_language, 'en') ~* '^en(-|$)'
          AND r.created_at >= COALESCE((SELECT MAX(created_at) FROM preference_versions WHERE user_id = r.user_id), r.created_at)
          AND r.created_at >= COALESCE((SELECT MAX(created_at) FROM interaction_events WHERE user_id = r.user_id AND event_type IN ('feedback_up', 'feedback_down')), r.created_at)
        ORDER BY r.created_at LIMIT 1
        """,
        (user_id,),
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
        """
        UPDATE telegram_recommendation_queue
        SET recommendation_id = NULL, status = 'pending', generation_token = NULL, lease_expires_at = NULL,
            retry_after = NULL, last_error = NULL, updated_at = NOW()
        WHERE user_id = %s AND recommendation_id = %s
        """,
        (user_id, recommendation_id),
    )
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
