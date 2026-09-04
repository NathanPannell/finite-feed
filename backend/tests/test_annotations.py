import os
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

import backend.app.annotations as annotations
from backend.app.annotations import annotation_stats, AnnotationConflict, clean_display_text, next_annotation, record_annotation


PROFILE_ID = UUID("30000000-0000-4000-8000-000000000001")
SNAPSHOT_ID = UUID("41000000-0000-4000-8000-000000000001")


def _database_url() -> str:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL integration test")
    return database_url


def _prepare_pair(conn: psycopg.Connection, suffix: int, *, last_served: str | None = None) -> UUID:
    video_id = UUID(f"42000000-0000-4000-8000-{suffix:012d}")
    conn.execute(
        """
        INSERT INTO annotation_snapshots (
            id, snapshot_sha256, source_commit, source_migrations,
            profile_count, video_count, pair_count, provenance
        ) VALUES (%s, %s, 'test', ARRAY['0011'], 1, 8, 8, '{}')
        ON CONFLICT (id) DO NOTHING
        """,
        (SNAPSHOT_ID, f"{suffix:064x}"),
    )
    conn.execute(
        """
        INSERT INTO videos (
            id, youtube_video_id, channel_name, title, youtube_url, description,
            thumbnail_url, view_count, channel_baseline_views
        ) VALUES (%s, %s, 'Test channel', %s, %s, 'A practical description.',
                  'https://example.test/thumbnail.jpg', 1, 1)
        ON CONFLICT (youtube_video_id) DO UPDATE SET title = EXCLUDED.title
        """,
        (video_id, f"match-lab-test-{suffix}", f"Useful test {suffix}", f"https://youtube.com/watch?v=match-lab-test-{suffix}"),
    )
    conn.execute(
        """
        INSERT INTO annotation_videos (video_id, title, description, channel_name, source_updated_at, default_language)
        VALUES (%s, %s, 'A practical description.', 'Test channel', NOW(), 'en')
        ON CONFLICT (video_id) DO NOTHING
        """,
        (video_id, f"Useful test {suffix}"),
    )
    conn.execute(
        """
        INSERT INTO annotation_pair_scores (
            profile_id, video_id, relevance_score, difficulty_score, scoring_model,
            curated, predicted_fit, close_call, selection_rationale, decision_summary,
            scoring_model_version, snapshot_id, snapshot_provenance, last_served_at
        ) VALUES (%s, %s, .8, .5, 'test-model', TRUE, 'yes', FALSE,
                  'Useful controlled test pair.', 'Evidence strongly supports this deliberately selected profile video match.',
                  'v1', %s, '{}', %s)
        """,
        (PROFILE_ID, video_id, SNAPSHOT_ID, last_served),
    )
    conn.commit()
    return video_id


def _cleanup(conn: psycopg.Connection, video_ids: list[UUID]) -> None:
    conn.execute("DELETE FROM annotation_labels WHERE video_id = ANY(%s)", (video_ids,))
    conn.execute("DELETE FROM annotation_pair_scores WHERE video_id = ANY(%s)", (video_ids,))
    conn.execute("DELETE FROM annotation_videos WHERE video_id = ANY(%s)", (video_ids,))
    conn.execute("DELETE FROM videos WHERE id = ANY(%s)", (video_ids,))
    conn.execute(
        "DELETE FROM annotation_snapshots WHERE id = %s AND NOT EXISTS (SELECT 1 FROM annotation_pair_scores WHERE snapshot_id = %s)",
        (SNAPSHOT_ID, SNAPSHOT_ID),
    )
    conn.commit()


def _record(conn: psycopg.Connection, video_id: UUID, reviewer: UUID, label: str):
    return record_annotation(
        conn,
        annotator_id=reviewer,
        profile_id=PROFILE_ID,
        video_id=video_id,
        label=label,
        rationale="Controlled test.",
    )


def test_clean_display_text_repairs_mojibake_and_controls() -> None:
    assert clean_display_text("A\u00e2\u20ac\u2122s\x00  title\n") == "A’s title"


def test_repeat_review_is_rejected() -> None:
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        video_id = _prepare_pair(conn, 101)
        reviewer = uuid4()
        try:
            _record(conn, video_id, reviewer, "yes")
            with pytest.raises(AnnotationConflict, match="already judged"):
                _record(conn, video_id, reviewer, "no")
        finally:
            _cleanup(conn, [video_id])


def test_identical_retry_returns_the_durable_judgment_without_duplicating() -> None:
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        video_id = _prepare_pair(conn, 108)
        reviewer = uuid4()
        try:
            first = _record(conn, video_id, reviewer, "yes")
            retry = _record(conn, video_id, reviewer, "yes")
            assert retry["id"] == first["id"]
            count = conn.execute(
                "SELECT COUNT(*) AS count FROM annotation_labels WHERE profile_id = %s AND video_id = %s",
                (PROFILE_ID, video_id),
            ).fetchone()["count"]
            assert count == 1
        finally:
            _cleanup(conn, [video_id])


def test_two_matching_unique_reviews_reach_early_consensus() -> None:
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        video_id = _prepare_pair(conn, 102)
        try:
            _record(conn, video_id, uuid4(), "yes")
            _record(conn, video_id, uuid4(), "yes")
            state = conn.execute(
                "SELECT queue_status, consensus_label FROM annotation_pair_scores WHERE profile_id = %s AND video_id = %s",
                (PROFILE_ID, video_id),
            ).fetchone()
            assert state == {"queue_status": "consensus", "consensus_label": "yes"}
            with pytest.raises(AnnotationConflict, match="already closed"):
                _record(conn, video_id, uuid4(), "no")
        finally:
            _cleanup(conn, [video_id])


def test_three_different_reviews_escalate_and_close_pair() -> None:
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        video_id = _prepare_pair(conn, 103)
        try:
            for label in ("yes", "no", "unsure"):
                _record(conn, video_id, uuid4(), label)
            state = conn.execute(
                "SELECT queue_status, consensus_label FROM annotation_pair_scores WHERE profile_id = %s AND video_id = %s",
                (PROFILE_ID, video_id),
            ).fetchone()
            assert state == {"queue_status": "escalated", "consensus_label": None}
        finally:
            _cleanup(conn, [video_id])


def test_queue_rotates_fairly_across_equally_unreviewed_pairs(monkeypatch) -> None:
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        video_ids = [_prepare_pair(conn, suffix) for suffix in (104, 105, 106)]
        monkeypatch.setattr(annotations, "_eligible_video_ids", lambda conn: video_ids)
        try:
            served = {next_annotation(conn, uuid4())["video_id"] for _ in range(3)}
            assert len(served) == 3
        finally:
            _cleanup(conn, video_ids)


def test_next_annotation_includes_source_thumbnail(monkeypatch) -> None:
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        video_id = _prepare_pair(conn, 109)
        monkeypatch.setattr(annotations, "_eligible_video_ids", lambda conn: [video_id])
        try:
            card = next_annotation(conn, uuid4())
            assert card["thumbnail_url"] == "https://example.test/thumbnail.jpg"
        finally:
            _cleanup(conn, [video_id])


def test_concurrent_submissions_never_exceed_pair_capacity() -> None:
    database_url = _database_url()
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        video_id = _prepare_pair(conn, 107)
    reviewers = [uuid4() for _ in range(8)]

    def submit(index: int) -> str:
        try:
            with psycopg.connect(database_url, row_factory=dict_row) as concurrent_conn:
                _record(concurrent_conn, video_id, reviewers[index], ("yes", "no", "unsure")[index % 3])
            return "saved"
        except AnnotationConflict:
            return "closed"

    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            outcomes = list(executor.map(submit, range(8)))
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            count = conn.execute(
                "SELECT COUNT(*) AS count FROM annotation_labels WHERE profile_id = %s AND video_id = %s",
                (PROFILE_ID, video_id),
            ).fetchone()["count"]
            status = conn.execute(
                "SELECT queue_status FROM annotation_pair_scores WHERE profile_id = %s AND video_id = %s",
                (PROFILE_ID, video_id),
            ).fetchone()["queue_status"]
            assert 2 <= count <= 3
            assert outcomes.count("saved") == count
            assert status in {"consensus", "escalated"}
            _cleanup(conn, [video_id])
    finally:
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            _cleanup(conn, [video_id])


def test_language_filter_and_clean_description_survive_curated_queue(monkeypatch):
    with psycopg.connect(_database_url(), row_factory=dict_row) as conn:
        english = _prepare_pair(conn, 110)
        spanish = _prepare_pair(conn, 111)
        try:
            conn.execute("UPDATE annotation_videos SET default_language = 'es' WHERE video_id = %s", (spanish,))
            conn.execute("UPDATE annotation_videos SET description = %s WHERE video_id = %s",
                         ("A researcher explains practical methods for making better decisions.\nSubscribe to our channel", english))
            conn.commit()
            eligible = annotations._eligible_video_ids(conn)
            assert english in eligible
            assert spanish not in eligible
            monkeypatch.setattr(annotations, "_eligible_video_ids", lambda conn: [english])
            reviewer = uuid4()
            card = next_annotation(conn, reviewer)
            assert card["video_id"] == english
            assert "Subscribe" not in card["description"]
            assert annotation_stats(conn, reviewer)["remaining"] == 1
            assert _record(conn, spanish, reviewer, "yes") is None
            _record(conn, english, reviewer, "yes")
            assert annotation_stats(conn, reviewer)["remaining"] == 0
        finally:
            _cleanup(conn, [english, spanish])
