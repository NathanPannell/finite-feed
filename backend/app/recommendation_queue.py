from datetime import UTC, datetime, timedelta
from uuid import UUID

from psycopg import Connection

from backend.app.settings import Settings

QUEUE_TARGET = 2
GENERATION_LEASE = timedelta(minutes=5)


def invalidate_recommendation_queue(conn: Connection, user_id: UUID) -> None:
    """Reset both durable slots to the user's latest preference version."""
    conn.execute("SELECT id FROM app_users WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
    profile = conn.execute(
        "SELECT id FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if not profile:
        conn.execute("DELETE FROM telegram_recommendation_queue WHERE user_id = %s", (user_id,))
        return
    for slot in range(1, QUEUE_TARGET + 1):
        conn.execute(
            """
            INSERT INTO telegram_recommendation_queue
                (user_id, slot, preference_version_id, status)
            VALUES (%s, %s, %s, 'pending')
            ON CONFLICT (user_id, slot) DO UPDATE SET
                preference_version_id = EXCLUDED.preference_version_id,
                recommendation_id = NULL,
                status = 'pending',
                generation_token = NULL,
                lease_expires_at = NULL,
                retry_after = NULL,
                last_error = NULL,
                updated_at = NOW()
            """,
            (user_id, slot, profile["id"]),
        )


def ensure_recommendation_queue(conn: Connection, user_id: UUID) -> None:
    """Create missing slots and invalidate slots left on an older profile."""
    profile = conn.execute(
        "SELECT id FROM preference_versions WHERE user_id = %s ORDER BY version DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if not profile:
        return
    for slot in range(1, QUEUE_TARGET + 1):
        conn.execute(
            """
            INSERT INTO telegram_recommendation_queue
                (user_id, slot, preference_version_id, status)
            VALUES (%s, %s, %s, 'pending')
            ON CONFLICT (user_id, slot) DO UPDATE SET
                preference_version_id = EXCLUDED.preference_version_id,
                recommendation_id = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.recommendation_id
                    ELSE NULL
                END,
                status = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.status
                    ELSE 'pending'
                END,
                generation_token = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.generation_token
                    ELSE NULL
                END,
                lease_expires_at = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.lease_expires_at
                    ELSE NULL
                END,
                retry_after = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.retry_after
                    ELSE NULL
                END,
                last_error = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.last_error
                    ELSE NULL
                END,
                updated_at = CASE
                    WHEN telegram_recommendation_queue.preference_version_id = EXCLUDED.preference_version_id
                    THEN telegram_recommendation_queue.updated_at
                    ELSE NOW()
                END
            """,
            (user_id, slot, profile["id"]),
        )
    conn.execute(
        """
        UPDATE telegram_recommendation_queue q
        SET recommendation_id = NULL, status = 'pending', generation_token = NULL,
            lease_expires_at = NULL, retry_after = NULL, last_error = NULL, updated_at = NOW()
        WHERE q.user_id = %s AND q.recommendation_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM recommendations r
              JOIN videos v ON v.id = r.video_id
              JOIN tracked_channels c ON c.id = v.tracked_channel_id
              JOIN user_channel_follows f ON f.channel_id = c.id AND f.user_id = q.user_id
              WHERE r.id = q.recommendation_id AND r.delivered_at IS NULL
                AND r.preference_version_id = q.preference_version_id
                AND c.is_active AND v.is_available
                AND COALESCE(v.default_audio_language, v.default_language, 'en') ~* '^en(-|$)'
          )
        """,
        (user_id,),
    )


def claim_queued_recommendation(
    conn: Connection, user_id: UUID, require_model: bool = True,
) -> UUID | None:
    """Lock and return one current-profile recommendation without generating it."""
    account = conn.execute(
        """SELECT id FROM app_users
           WHERE id = %s AND telegram_user_id IS NOT NULL AND deleted_at IS NULL
           FOR UPDATE""",
        (user_id,),
    ).fetchone()
    if not account:
        return None
    model_filter = "AND r.evidence->>'reranker_fallback' = 'false'" if require_model else ""
    row = conn.execute(
        f"""
        SELECT r.id
        FROM telegram_recommendation_queue q
        JOIN recommendations r ON r.id = q.recommendation_id
        JOIN preference_versions p ON p.id = q.preference_version_id
        JOIN videos v ON v.id = r.video_id
        JOIN tracked_channels c ON c.id = v.tracked_channel_id
        JOIN user_channel_follows f ON f.channel_id = c.id AND f.user_id = q.user_id
        WHERE q.user_id = %s
          AND q.status = 'ready'
          AND r.delivered_at IS NULL
          AND r.preference_version_id = q.preference_version_id
          AND p.id = (SELECT id FROM preference_versions WHERE user_id = q.user_id ORDER BY version DESC LIMIT 1)
          AND c.is_active AND v.is_available
          AND COALESCE(v.default_audio_language, v.default_language, 'en') ~* '^en(-|$)'
          {model_filter}
        ORDER BY q.slot
        FOR UPDATE OF q, r SKIP LOCKED
        LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    return row["id"] if row else None


def _adopt_orphaned_recommendation(conn: Connection, user_id: UUID) -> bool:
    """Recover a committed generation whose queue bind did not complete."""
    account = conn.execute(
        """SELECT id FROM app_users
           WHERE id = %s AND telegram_user_id IS NOT NULL AND deleted_at IS NULL
           FOR UPDATE""",
        (user_id,),
    ).fetchone()
    if not account:
        conn.rollback()
        return False
    ensure_recommendation_queue(conn, user_id)
    adopted = conn.execute(
        """
        WITH empty_slot AS (
            SELECT q.user_id, q.slot, q.preference_version_id
            FROM telegram_recommendation_queue q
            WHERE q.user_id = %s AND q.recommendation_id IS NULL
              AND (q.status = 'pending' OR
                   (q.status = 'generating' AND q.lease_expires_at <= NOW()))
            ORDER BY q.slot
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        ), orphan AS (
            SELECT r.id
            FROM empty_slot slot
            JOIN recommendations r ON r.user_id = slot.user_id
                                     AND r.preference_version_id = slot.preference_version_id
            JOIN videos v ON v.id = r.video_id
            JOIN tracked_channels c ON c.id = v.tracked_channel_id
            JOIN user_channel_follows f ON f.channel_id = c.id AND f.user_id = slot.user_id
            WHERE r.delivered_at IS NULL
              AND r.evidence->>'reranker_fallback' = 'false'
              AND r.created_at >= COALESCE((
                  SELECT MAX(created_at) FROM interaction_events
                  WHERE user_id = slot.user_id
                    AND event_type IN ('feedback_up', 'feedback_down')
              ), r.created_at)
              AND c.is_active AND v.is_available
              AND COALESCE(v.default_audio_language, v.default_language, 'en') ~* '^en(-|$)'
              AND NOT EXISTS (
                  SELECT 1 FROM telegram_recommendation_queue used
                  WHERE used.recommendation_id = r.id
              )
            ORDER BY r.created_at
            FOR UPDATE OF r SKIP LOCKED
            LIMIT 1
        )
        UPDATE telegram_recommendation_queue q
        SET recommendation_id = orphan.id, status = 'ready', generation_token = NULL,
            lease_expires_at = NULL, retry_after = NULL, last_error = NULL, updated_at = NOW()
        FROM empty_slot, orphan
        WHERE q.user_id = empty_slot.user_id AND q.slot = empty_slot.slot
        RETURNING q.slot
        """,
        (user_id,),
    ).fetchone()
    conn.commit()
    return bool(adopted)


def _claim_refill_slot(conn: Connection, user_id: UUID, retry_minutes: int) -> dict | None:
    account = conn.execute(
        """SELECT id FROM app_users
           WHERE id = %s AND telegram_user_id IS NOT NULL AND deleted_at IS NULL
           FOR UPDATE""",
        (user_id,),
    ).fetchone()
    if not account:
        conn.rollback()
        return None
    ensure_recommendation_queue(conn, user_id)
    now = datetime.now(UTC)
    row = conn.execute(
        """
        WITH candidate AS (
            SELECT user_id, slot
            FROM telegram_recommendation_queue
            WHERE user_id = %s
              AND recommendation_id IS NULL
              AND (retry_after IS NULL OR retry_after <= %s)
              AND (status = 'pending' OR (status = 'generating' AND lease_expires_at <= %s))
              AND NOT EXISTS (
                  SELECT 1 FROM telegram_recommendation_queue active
                  WHERE active.user_id = telegram_recommendation_queue.user_id
                    AND active.status = 'generating' AND active.lease_expires_at > %s
              )
            ORDER BY slot
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE telegram_recommendation_queue q
        SET status = 'generating', generation_token = gen_random_uuid(),
            lease_expires_at = %s, updated_at = %s
        FROM candidate
        WHERE q.user_id = candidate.user_id AND q.slot = candidate.slot
        RETURNING q.user_id, q.slot, q.preference_version_id, q.generation_token
        """,
        (user_id, now, now, now, now + GENERATION_LEASE, now),
    ).fetchone()
    conn.commit()
    return row


def refill_recommendation_queue(
    conn: Connection, settings: Settings, user_id: UUID, retry_minutes: int,
) -> int:
    """Lease, generate, and bind every currently fillable queue slot."""
    from backend.app.recommendations import generate_recommendation

    filled = 0
    while True:
        if _adopt_orphaned_recommendation(conn, user_id):
            filled += 1
            continue
        slot = _claim_refill_slot(conn, user_id, retry_minutes)
        if not slot:
            break
        try:
            recommendation_id = generate_recommendation(
                conn,
                settings,
                user_id,
                require_model=True,
                expected_preference_version_id=slot["preference_version_id"],
            )
            bound = conn.execute(
                """
                UPDATE telegram_recommendation_queue q
                SET recommendation_id = %s, status = 'ready', generation_token = NULL, lease_expires_at = NULL,
                    retry_after = NULL, last_error = NULL, updated_at = NOW()
                WHERE q.user_id = %s AND q.slot = %s
                  AND q.preference_version_id = %s AND q.status = 'generating'
                  AND q.generation_token = %s
                  AND EXISTS (
                      SELECT 1 FROM recommendations r
                      WHERE r.id = %s AND r.preference_version_id = q.preference_version_id
                  )
                RETURNING q.slot
                """,
                (
                    recommendation_id, user_id, slot["slot"],
                    slot["preference_version_id"], slot["generation_token"], recommendation_id,
                ),
            ).fetchone()
            conn.commit()
            filled += int(bool(bound))
        except Exception as exc:
            conn.rollback()
            conn.execute(
                """
                UPDATE telegram_recommendation_queue
                SET status = 'pending', generation_token = NULL, lease_expires_at = NULL,
                    retry_after = NOW() + make_interval(mins => %s),
                    last_error = %s, updated_at = NOW()
                WHERE user_id = %s AND slot = %s AND preference_version_id = %s
                  AND generation_token = %s
                """,
                (
                    retry_minutes, type(exc).__name__, user_id, slot["slot"],
                    slot["preference_version_id"], slot["generation_token"],
                ),
            )
            conn.commit()
            break
    return filled
