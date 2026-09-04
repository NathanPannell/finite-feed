import re
from uuid import UUID, uuid4

from psycopg import Connection

from backend.app.description_processing import (
    clean_description,
    is_english_metadata,
    normalize_display_text,
)


def clean_display_text(value: str) -> str:
    return re.sub(r"\s+", " ", normalize_display_text(value)).strip()


def next_annotation(conn: Connection, annotator_id: UUID):
    rows = conn.execute(
        """
        SELECT p.id AS profile_id, v.video_id, p.summary, p.topics, v.title, v.description
        FROM annotation_profiles p
        CROSS JOIN annotation_videos v
        LEFT JOIN annotation_pair_scores score
          ON score.profile_id = p.id AND score.video_id = v.video_id
        LEFT JOIN annotation_labels mine
          ON mine.profile_id = p.id
         AND mine.video_id = v.video_id
         AND mine.annotator_id = %s
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS label_count
            FROM annotation_labels all_labels
            WHERE all_labels.profile_id = p.id AND all_labels.video_id = v.video_id
        ) coverage ON TRUE
        WHERE p.active AND mine.id IS NULL
        ORDER BY
            (score.difficulty_score IS NULL),
            score.difficulty_score DESC NULLS LAST,
            coverage.label_count,
            md5(p.id::text || ':' || v.video_id::text || ':' || %s::text)
        """,
        (annotator_id, annotator_id),
    ).fetchall()
    row = next(
        (row for row in rows if is_english_metadata(row["title"], row["description"])),
        None,
    )
    if row is None:
        return None
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
    video = conn.execute(
        "SELECT title, description FROM annotation_videos WHERE video_id = %s",
        (video_id,),
    ).fetchone()
    if not video or not is_english_metadata(video["title"], video["description"]):
        conn.rollback()
        return None
    row = conn.execute(
        """
        INSERT INTO annotation_labels (
            id, profile_id, video_id, annotator_id, annotator_kind, label, rationale
        )
        SELECT %s, p.id, v.video_id, %s, %s, %s, %s
        FROM annotation_profiles p
        JOIN annotation_videos v ON v.video_id = %s
        WHERE p.id = %s AND p.active
        ON CONFLICT (profile_id, video_id, annotator_id)
        DO UPDATE SET
            label = EXCLUDED.label,
            rationale = EXCLUDED.rationale,
            annotator_kind = EXCLUDED.annotator_kind,
            updated_at = NOW()
        RETURNING id, profile_id, video_id, annotator_id, annotator_kind, label, rationale, created_at
        """,
        (uuid4(), annotator_id, annotator_kind, label, rationale, video_id, profile_id),
    ).fetchone()
    if row:
        conn.commit()
    else:
        conn.rollback()
        return None
    return row


def annotation_stats(conn: Connection, annotator_id: UUID) -> dict[str, int]:
    videos = conn.execute("SELECT video_id, title, description FROM annotation_videos").fetchall()
    eligible_ids = [
        row["video_id"]
        for row in videos
        if is_english_metadata(row["title"], row["description"])
    ]
    active_profiles = conn.execute(
        "SELECT COUNT(*) AS count FROM annotation_profiles WHERE active"
    ).fetchone()["count"]
    completed = conn.execute(
        """
        SELECT COUNT(*) AS count
        FROM annotation_labels label
        JOIN annotation_profiles profile ON profile.id = label.profile_id
        WHERE label.annotator_id = %s AND profile.active
          AND label.video_id = ANY(%s::uuid[])
        """,
        (annotator_id, eligible_ids),
    ).fetchone()["count"]
    total = active_profiles * len(eligible_ids)
    return {"completed": completed, "remaining": max(total - completed, 0)}
