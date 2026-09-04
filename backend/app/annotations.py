import html
import re
import unicodedata
from uuid import UUID, uuid4

from psycopg import Connection

from backend.app.auth import AuthenticatedAnnotator


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


_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_EMAIL = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")
_HASHTAG = re.compile(r"(?<!\w)#[\w-]+", re.UNICODE)
_CHAPTER = re.compile(r"^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\b")
_ALWAYS_BOILERPLATE_PREFIXES = (
    "about ted",
    "about tedx",
    "copyright",
    "credits:",
    "follow us",
    "follow ted",
    "music:",
    "shop ted",
    "subscribe",
    "support ted",
    "this talk was given at a tedx",
    "visit ted",
)
_LINKED_BOILERPLATE_PREFIXES = (
    "connect with",
    "learn more:",
    "watch more",
)


def clean_video_description(value: str, title: str = "") -> str:
    """Return meaningful prose while deterministically removing YouTube boilerplate."""
    text = html.unescape(value or "").replace("\r\n", "\n").replace("\r", "\n")
    for broken, replacement in _MOJIBAKE.items():
        text = text.replace(broken, replacement)
    text = unicodedata.normalize("NFKC", text)
    text = "".join(
        character
        for character in text
        if character == "\n" or not unicodedata.category(character).startswith("C")
    )
    normalized_title = clean_display_text(title).casefold()
    kept: list[str] = []
    seen: set[str] = set()
    for raw_line in text.split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip(" \t|\u2022")
        if not line or _CHAPTER.match(line):
            continue
        lowered = line.casefold()
        without_suffix = re.sub(r"\s*\|\s*(?:tedx?|ted talk)\s*$", "", lowered).strip()
        if normalized_title and without_suffix == normalized_title:
            continue
        has_link = bool(_URL.search(line) or _EMAIL.search(line))
        if lowered.startswith(_ALWAYS_BOILERPLATE_PREFIXES):
            continue
        if has_link and lowered.startswith(_LINKED_BOILERPLATE_PREFIXES):
            continue
        if lowered.startswith(("speaker:", "translator:", "filmed at", "recorded at")):
            continue
        line = _URL.sub("", line)
        line = _EMAIL.sub("", line)
        line = _HASHTAG.sub("", line)
        line = re.sub(r"\s+", " ", line).strip(" \t|,;–—-")
        if not line:
            continue
        key = line.casefold()
        if key in seen:
            continue
        seen.add(key)
        kept.append(line)
    return "\n\n".join(kept)


def next_annotation(conn: Connection, annotator_id: UUID):
    row = conn.execute(
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
        "description": clean_video_description(row["description"], row["title"]),
    }


def record_annotation(
    conn: Connection,
    *,
    annotator: AuthenticatedAnnotator,
    profile_id: UUID,
    video_id: UUID,
    label: str,
    rationale: str | None,
):
    conn.execute(
        """
        INSERT INTO annotation_annotators (
            id, kind, issuer, subject, email, name, image_url
        ) VALUES (%s, 'google', %s, %s, %s, %s, %s)
        ON CONFLICT (issuer, subject)
        DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            image_url = EXCLUDED.image_url,
            last_seen_at = NOW()
        """,
        (
            annotator.annotator_id,
            annotator.issuer,
            annotator.subject,
            annotator.email,
            annotator.name,
            annotator.image_url,
        ),
    )
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
        (uuid4(), annotator.annotator_id, "google", label, rationale, video_id, profile_id),
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
