import os
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app.annotations import annotation_stats, clean_display_text, clean_video_description, next_annotation, record_annotation
from backend.app.auth import AuthenticatedAnnotator


ANNOTATOR_ID = UUID("40000000-0000-4000-8000-000000000001")
VIDEO_ID = UUID("40000000-0000-4000-8000-000000000002")
PROFILE_ID = UUID("30000000-0000-4000-8000-000000000001")
ANNOTATOR = AuthenticatedAnnotator(
    ANNOTATOR_ID, "https://auth.example.test", "google-user-1", "viewer@example.com", "Example Viewer", None,
)


def test_clean_display_text_repairs_mojibake_and_controls() -> None:
    assert clean_display_text("A\u00e2\u20ac\u2122s\x00  title\n") == "A’s title"


def test_clean_video_description_keeps_meat_and_removes_youtube_junk() -> None:
    value = """
    How to build a calmer internet | TED
    A researcher explains how small design choices can protect attention. https://ted.com/talks/example #TED #TEDTalks
    00:00 Introduction
    01:42 The first experiment
    Subscribe to TED: https://youtube.com/ted
    Follow TED on Instagram: https://instagram.com/ted
    About TEDx: Independently organized ideas worth spreading.
    """
    assert clean_video_description(value, "How to build a calmer internet") == (
        "A researcher explains how small design choices can protect attention."
    )


def test_clean_video_description_is_idempotent_and_preserves_real_prose() -> None:
    value = "Learn more: our brains adapt through repeated practice.\n\n#TEDx https://ted.com"
    cleaned = clean_video_description(value)
    assert cleaned == "Learn more: our brains adapt through repeated practice."
    assert clean_video_description(cleaned) == cleaned


def test_annotation_round_trip() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute("DELETE FROM annotation_labels WHERE annotator_id = %s", (ANNOTATOR_ID,))
        conn.execute("DELETE FROM annotation_annotators WHERE id = %s", (ANNOTATOR_ID,))
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
            INSERT INTO annotation_videos (video_id, title, description, channel_name, source_updated_at)
            VALUES (%s, 'A useful test', 'A practical description.', 'Test channel', NOW())
            """,
            (VIDEO_ID,),
        )
        conn.commit()

        card = next_annotation(conn, ANNOTATOR_ID)
        assert card
        assert card["video_id"] == VIDEO_ID
        result = record_annotation(
            conn,
            annotator=ANNOTATOR,
            profile_id=PROFILE_ID,
            video_id=VIDEO_ID,
            label="yes",
            rationale="Clear fit.",
        )
        assert result["label"] == "yes"
        assert result["annotator_kind"] == "google"
        assert annotation_stats(conn, ANNOTATOR_ID)["completed"] == 1
        saved_annotator = conn.execute(
            "SELECT email, name FROM annotation_annotators WHERE id = %s", (ANNOTATOR_ID,)
        ).fetchone()
        assert saved_annotator == {"email": "viewer@example.com", "name": "Example Viewer"}

        conn.execute("DELETE FROM annotation_labels WHERE annotator_id = %s", (ANNOTATOR_ID,))
        conn.execute("DELETE FROM annotation_annotators WHERE id = %s", (ANNOTATOR_ID,))
        conn.execute("DELETE FROM annotation_videos WHERE video_id = %s", (VIDEO_ID,))
        conn.execute("DELETE FROM videos WHERE id = %s", (VIDEO_ID,))
        conn.commit()
