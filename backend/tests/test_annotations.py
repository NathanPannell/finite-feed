import os
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row

from backend.app.annotations import annotation_stats, clean_display_text, next_annotation, record_annotation


ANNOTATOR_ID = UUID("40000000-0000-4000-8000-000000000001")
VIDEO_ID = UUID("40000000-0000-4000-8000-000000000002")
PROFILE_ID = UUID("30000000-0000-4000-8000-000000000001")


def test_clean_display_text_repairs_mojibake_and_controls() -> None:
    assert clean_display_text("A\u00e2\u20ac\u2122s\x00  title\n") == "A’s title"


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
                thumbnail_url, view_count, channel_baseline_views
            ) VALUES (%s, 'annotation-test-video', 'Test channel', 'A useful test',
                      'https://youtube.com/watch?v=annotation-test-video',
                      'A practical description.', 'https://i.ytimg.com/vi/annotation-test-video/hqdefault.jpg', 1, 1)
            ON CONFLICT (youtube_video_id) DO UPDATE SET
                title = EXCLUDED.title,
                thumbnail_url = EXCLUDED.thumbnail_url
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
        assert card["thumbnail_url"] == "https://i.ytimg.com/vi/annotation-test-video/hqdefault.jpg"
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
