import re
from uuid import UUID, uuid4

from psycopg import Connection


from backend.app.description_processing import clean_description, is_english_metadata, normalize_display_text


class AnnotationConflict(RuntimeError):
    pass


def clean_display_text(value: str) -> str:
    return re.sub(r"\s+", " ", normalize_display_text(value)).strip()


def _eligible_video_ids(conn: Connection) -> list[UUID]:
    # Classify each video once, never the profiles-by-videos cross product.
    rows = conn.execute("""SELECT DISTINCT v.video_id, v.title, v.description,
        v.default_language, v.default_audio_language
        FROM annotation_videos v
        JOIN annotation_pair_scores score ON score.video_id = v.video_id AND score.curated
        """).fetchall()
    return [row["video_id"] for row in rows if is_english_metadata(
        row["title"], row["description"], row["default_language"], row["default_audio_language"]
    )]


def next_annotation(conn: Connection, annotator_id: UUID):
    eligible_ids = _eligible_video_ids(conn)
    row = conn.execute(
        """
        SELECT score.profile_id, score.video_id, p.summary, p.topics,
               v.title, v.description, source.thumbnail_url
        FROM annotation_pair_scores score
        JOIN annotation_profiles p ON p.id = score.profile_id AND p.active
        JOIN annotation_videos v ON v.video_id = score.video_id
        JOIN videos source ON source.id = v.video_id
        LEFT JOIN annotation_labels mine
          ON mine.profile_id = score.profile_id
         AND mine.video_id = score.video_id
         AND mine.annotator_id = %s
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS label_count
            FROM annotation_labels labels
            WHERE labels.profile_id = score.profile_id AND labels.video_id = score.video_id
        ) coverage ON TRUE
        WHERE score.curated
          AND score.queue_status = 'open'
          AND mine.id IS NULL
          AND coverage.label_count < 3
          AND score.video_id = ANY(%s::uuid[])
        ORDER BY
            coverage.label_count,
            score.last_served_at NULLS FIRST,
            md5(score.profile_id::text || ':' || score.video_id::text)
        FOR UPDATE OF score SKIP LOCKED
        LIMIT 1
        """,
        (annotator_id, eligible_ids),
    ).fetchone()
    if not row:
        conn.rollback()
        return None
    conn.execute(
        """
        UPDATE annotation_pair_scores
        SET last_served_at = clock_timestamp()
        WHERE profile_id = %s AND video_id = %s
        """,
        (row["profile_id"], row["video_id"]),
    )
    conn.commit()
    return {
        **row,
        "summary": clean_display_text(row["summary"]),
        "topics": [clean_display_text(topic) for topic in row["topics"]],
        "title": clean_display_text(row["title"]),
        "description": clean_description(row["description"]),
    }


def record_annotation(
    conn: Connection,
    *,
    annotator_id: UUID,
    profile_id: UUID,
    video_id: UUID,
    label: str,
    rationale: str | None,
    annotator_kind: str = "anonymous",
):
    video = conn.execute("""SELECT title, description, default_language, default_audio_language
        FROM annotation_videos WHERE video_id = %s""", (video_id,)).fetchone()
    if not video or not is_english_metadata(video["title"], video["description"],
                                            video["default_language"], video["default_audio_language"]):
        conn.rollback()
        return None
    pair = conn.execute(
        """
        SELECT predicted_fit, close_call, decision_summary, queue_status
        FROM annotation_pair_scores
        WHERE profile_id = %s AND video_id = %s AND curated
        FOR UPDATE
        """,
        (profile_id, video_id),
    ).fetchone()
    if not pair:
        conn.rollback()
        return None

    existing = conn.execute(
        """
        SELECT id, profile_id, video_id, label, rationale, created_at
        FROM annotation_labels
        WHERE profile_id = %s AND video_id = %s AND annotator_id = %s
        """,
        (profile_id, video_id, annotator_id),
    ).fetchone()
    if existing:
        conn.rollback()
        if existing["label"] == label and existing["rationale"] == rationale:
            return {
                **existing,
                "assessment": {
                    "predicted_fit": pair["predicted_fit"],
                    "close_call": pair["close_call"],
                    "decision_summary": clean_display_text(pair["decision_summary"]),
                },
            }
        raise AnnotationConflict("This reviewer already judged this pair")
    if pair["queue_status"] != "open":
        conn.rollback()
        raise AnnotationConflict("This pair is already closed")

    current_count = conn.execute(
        "SELECT COUNT(*) AS count FROM annotation_labels WHERE profile_id = %s AND video_id = %s",
        (profile_id, video_id),
    ).fetchone()["count"]
    if current_count >= 3:
        conn.execute(
            """
            UPDATE annotation_pair_scores SET queue_status = 'escalated', consensus_label = NULL
            WHERE profile_id = %s AND video_id = %s
            """,
            (profile_id, video_id),
        )
        conn.commit()
        raise AnnotationConflict("This pair has reached its review limit")

    result = conn.execute(
        """
        INSERT INTO annotation_labels (
            id, profile_id, video_id, annotator_id, annotator_kind, label, rationale
        ) VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id, profile_id, video_id, label, rationale, created_at
        """,
        (uuid4(), profile_id, video_id, annotator_id, annotator_kind, label, rationale),
    ).fetchone()
    counts = conn.execute(
        """
        SELECT label, COUNT(*) AS count
        FROM annotation_labels
        WHERE profile_id = %s AND video_id = %s
        GROUP BY label
        ORDER BY count DESC, label
        """,
        (profile_id, video_id),
    ).fetchall()
    consensus = next((item["label"] for item in counts if item["count"] >= 2), None)
    total = sum(item["count"] for item in counts)
    if consensus:
        conn.execute(
            """
            UPDATE annotation_pair_scores SET queue_status = 'consensus', consensus_label = %s
            WHERE profile_id = %s AND video_id = %s
            """,
            (consensus, profile_id, video_id),
        )
    elif total >= 3:
        conn.execute(
            """
            UPDATE annotation_pair_scores SET queue_status = 'escalated', consensus_label = NULL
            WHERE profile_id = %s AND video_id = %s
            """,
            (profile_id, video_id),
        )
    conn.commit()
    return {
        **result,
        "assessment": {
            "predicted_fit": pair["predicted_fit"],
            "close_call": pair["close_call"],
            "decision_summary": clean_display_text(pair["decision_summary"]),
        },
    }


def annotation_stats(conn: Connection, annotator_id: UUID) -> dict[str, int]:
    eligible_ids = _eligible_video_ids(conn)
    row = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM annotation_labels WHERE annotator_id = %s) AS completed,
            (
                SELECT COUNT(*)
                FROM annotation_pair_scores score
                WHERE score.curated
                  AND score.queue_status = 'open'
                  AND score.video_id = ANY(%s::uuid[])
                  AND EXISTS (SELECT 1 FROM annotation_profiles p WHERE p.id = score.profile_id AND p.active)
                  AND NOT EXISTS (
                      SELECT 1 FROM annotation_labels mine
                      WHERE mine.profile_id = score.profile_id
                        AND mine.video_id = score.video_id
                        AND mine.annotator_id = %s
                  )
            ) AS remaining
        """,
        (annotator_id, eligible_ids, annotator_id),
    ).fetchone()
    return {"completed": row["completed"], "remaining": row["remaining"]}
