import html
import re
import unicodedata
from uuid import UUID, uuid4

from psycopg import Connection


_MOJIBAKE = {
    "\u00e2\u20ac\u2122": "’",
    "\u00e2\u20ac\u0153": "“",
    "\u00e2\u20ac\u009d": "”",
    "\u00e2\u20ac\u201c": "–",
    "\u00e2\u20ac\u201d": "—",
    "\u00c2": "",
    "\ufffd": "",
}


def clean_display_text(value: str) -> str:
    text = html.unescape(value or "")
    for broken, replacement in _MOJIBAKE.items():
        text = text.replace(broken, replacement)
    text = unicodedata.normalize("NFKC", text)
    text = "".join(
        character
        for character in text
        if character in {"\n", "\t"} or not unicodedata.category(character).startswith("C")
    )
    return re.sub(r"\s+", " ", text).strip()


def next_annotation(conn: Connection, annotator_id: UUID):
    row = conn.execute(
        """
        SELECT p.id AS profile_id, v.video_id, p.summary, p.topics, v.title, v.description,
               source.thumbnail_url
        FROM annotation_profiles p
        CROSS JOIN annotation_videos v
        JOIN videos source ON source.id = v.video_id
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
        LIMIT 1
        """,
        (annotator_id, annotator_id),
    ).fetchone()
    if not row:
        return None
    return {
        **row,
        "summary": clean_display_text(row["summary"]),
        "topics": [clean_display_text(topic) for topic in row["topics"]],
        "title": clean_display_text(row["title"]),
        "description": clean_display_text(row["description"]),
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
    return row


def annotation_stats(conn: Connection, annotator_id: UUID) -> dict[str, int]:
    row = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM annotation_labels WHERE annotator_id = %s) AS completed,
            (SELECT COUNT(*) FROM annotation_profiles WHERE active)
              * (SELECT COUNT(*) FROM annotation_videos) AS total
        """,
        (annotator_id,),
    ).fetchone()
    return {"completed": row["completed"], "remaining": max(row["total"] - row["completed"], 0)}
