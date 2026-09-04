import os
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app.annotations import annotation_stats, clean_display_text, next_annotation, record_annotation


ANNOTATOR_ID = UUID("40000000-0000-4000-8000-000000000001")
VIDEO_ID = UUID("40000000-0000-4000-8000-000000000002")
PROFILE_ID = UUID("30000000-0000-4000-8000-000000000001")


def test_clean_display_text_repairs_mojibake_and_controls() -> None:
    assert clean_display_text("A\u00e2\u20ac\u2122s\x00  title\n") == "A’s title"


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class _AnnotationConnection:
    def __init__(self, results):
        self.results = list(results)
        self.executions = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, query, params=()):
        self.executions.append((" ".join(query.split()), params))
        return _Result(self.results.pop(0))

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_next_annotation_skips_non_english_and_cleans_derived_description() -> None:
    spanish = {
        "profile_id": PROFILE_ID,
        "video_id": uuid4(),
        "summary": "Useful city ideas",
        "topics": ["cities"],
        "title": "Cómo mejorar nuestras ciudades",
        "description": "Una arquitecta explica cómo crear barrios más saludables.",
    }
    english = {
        "profile_id": PROFILE_ID,
        "video_id": VIDEO_ID,
        "summary": "Useful city ideas",
        "topics": ["cities"],
        "title": "How to improve our cities",
        "description": "A planner explains how streets shape health.\n#TED #cities",
        "thumbnail_url": "https://example.test/cities.jpg",
    }
    conn = _AnnotationConnection([[spanish, english]])

    card = next_annotation(conn, ANNOTATOR_ID)

    assert card["video_id"] == VIDEO_ID
    assert card["description"] == "A planner explains how streets shape health."
    assert card["thumbnail_url"] == "https://example.test/cities.jpg"
    assert english["description"].endswith("#TED #cities")


def test_record_annotation_rejects_ineligible_video_before_insert() -> None:
    conn = _AnnotationConnection([[
        {
            "title": "Pourquoi les villes changent",
            "description": "Une architecte explique comment les quartiers évoluent.",
        }
    ]])

    result = record_annotation(
        conn,
        annotator_id=ANNOTATOR_ID,
        profile_id=PROFILE_ID,
        video_id=VIDEO_ID,
        label="yes",
        rationale=None,
    )

    assert result is None
    assert len(conn.executions) == 1
    assert conn.rollbacks == 1


def test_annotation_round_trip() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute("DELETE FROM annotation_labels WHERE annotator_id = %s", (ANNOTATOR_ID,))
        conn.execute("DELETE FROM annotation_videos WHERE video_id = %s", (VIDEO_ID,))
        conn.execute(
            """
            INSERT INTO videos (
                id, youtube_video_id, channel_name, title, youtube_url, description,
                view_count, channel_baseline_views
            ) VALUES (%s, 'annotation-test-video', 'Test channel', 'A useful test',
                      'https://youtube.com/watch?v=annotation-test-video',
                      'A practical description.', 1, 1)
            ON CONFLICT (youtube_video_id) DO UPDATE SET title = EXCLUDED.title
            """,
            (VIDEO_ID,),
        )
        conn.execute(
            """
            INSERT INTO annotation_videos (
                video_id, title, description, channel_name, source_updated_at, default_language
            )
            VALUES (%s, 'A useful test', 'A practical description.', 'Test channel', NOW(), 'en')
            """,
            (VIDEO_ID,),
        )
        conn.commit()

        card = next_annotation(conn, ANNOTATOR_ID)
        assert card
        assert card["video_id"] == VIDEO_ID
        result = record_annotation(
            conn,
            annotator_id=ANNOTATOR_ID,
            profile_id=PROFILE_ID,
            video_id=VIDEO_ID,
            label="yes",
            rationale="Clear fit.",
        )
        assert result["label"] == "yes"
        assert annotation_stats(conn, ANNOTATOR_ID)["completed"] == 1

        conn.execute("DELETE FROM annotation_labels WHERE annotator_id = %s", (ANNOTATOR_ID,))
        conn.execute("DELETE FROM annotation_videos WHERE video_id = %s", (VIDEO_ID,))
        conn.execute("DELETE FROM videos WHERE id = %s", (VIDEO_ID,))
        conn.commit()
