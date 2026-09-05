import hashlib
import json
import os
from collections import Counter
from copy import deepcopy
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from backend.tools.build_match_lab_seed import (
    CATEGORIES, DATASET, MIGRATION, ROOT, build_migration, canonical, load_dataset,
)


def test_seed_artifacts_have_complete_balanced_grounded_coverage() -> None:
    dataset = load_dataset()
    assert len(dataset["profiles"]) == 100
    assert len(dataset["videos"]) == 296
    assert len(dataset["pairs"]) == 200
    assert Counter(row["category"] for row in dataset["pairs"]) == CATEGORIES
    assert set(Counter(row["profile_id"] for row in dataset["pairs"]).values()) == {2}
    source = json.loads((DATASET / "source-snapshot.json").read_text(encoding="utf-8"))
    assert {row["id"] for row in dataset["videos"]} == {row["id"] for row in source["videos"]}
    assert sum(not row["description"].strip() for row in dataset["videos"]) == 2
    assert len({row["selection_rationale"] for row in dataset["pairs"]}) == 200
    assert dataset["scoring_model"] == "GPT-6"
    assert "awaiting independent human review" in dataset["curation_method"]


def test_seed_hash_and_sql_are_reproducible_and_sensitive_to_evidence() -> None:
    dataset = load_dataset()
    migrations = ["0011_match_lab_curated_queue.sql"]
    first = build_migration(dataset, "test-source", migrations)
    assert first == build_migration(deepcopy(dataset), "test-source", migrations)
    digest = hashlib.sha256(canonical(dataset)).hexdigest()
    assert digest in first
    modified = deepcopy(dataset)
    modified["pairs"][0]["selection_rationale"] += " Additional evidence."
    assert hashlib.sha256(canonical(modified)).hexdigest() != digest
    assert "INSERT INTO annotation_labels" not in first
    assert "DELETE FROM" not in first
    assert "ON CONFLICT (video_id) DO NOTHING" in first


def test_committed_migration_matches_the_source_artifacts() -> None:
    text = MIGRATION.read_text(encoding="utf-8")
    payload = json.loads(text.split("$dataset$", 2)[1])
    dataset = load_dataset()
    assert payload["snapshot_sha256"] == hashlib.sha256(canonical(dataset)).hexdigest()
    assert text == build_migration(dataset, payload["source_commit"], payload["source_migrations"])


@pytest.fixture
def seed_database():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url or urlsplit(database_url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.skip("A local disposable PostgreSQL DATABASE_URL is required for seed integration tests")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        try:
            schema = f"match_seed_test_{uuid4().hex}"
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
            conn.execute(sql.SQL("SET LOCAL search_path TO {}, public").format(sql.Identifier(schema)))
            for path in sorted((ROOT / "database" / "migrations").glob("*.sql")):
                if path.name >= MIGRATION.name:
                    break
                conn.execute(path.read_text(encoding="utf-8"))
            yield conn
        finally:
            # Never commit test rows or drop anything outside this temporary schema.
            conn.rollback()


def _counts(conn):
    return conn.execute("""
        SELECT (SELECT count(*) FROM annotation_profiles) AS profiles,
               (SELECT count(*) FROM videos) AS videos,
               (SELECT count(*) FROM annotation_videos) AS snapshots,
               (SELECT count(*) FROM annotation_pair_scores WHERE curated) AS pairs,
               (SELECT count(*) FROM annotation_labels) AS labels
    """).fetchone()


def test_seed_migration_fresh_database_and_replay(seed_database) -> None:
    conn = seed_database
    migration = MIGRATION.read_text(encoding="utf-8")
    conn.execute(migration)
    assert _counts(conn) == {"profiles": 100, "videos": 296, "snapshots": 296, "pairs": 200, "labels": 0}
    from backend.app.ingestion import video_fingerprint

    for video in conn.execute("SELECT title, description, content_fingerprint FROM videos").fetchall():
        assert video["content_fingerprint"] == video_fingerprint(video["title"], video["description"])
    assert conn.execute("SELECT count(*) AS count FROM annotation_pair_scores WHERE queue_status = 'open'").fetchone()["count"] == 200
    conn.execute(migration)
    assert _counts(conn) == {"profiles": 100, "videos": 296, "snapshots": 296, "pairs": 200, "labels": 0}
    assert conn.execute("SELECT count(*) AS count FROM annotation_snapshots").fetchone()["count"] == 1


def _insert_source(conn, video):
    conn.execute("""
        INSERT INTO videos (id, youtube_video_id, channel_name, title, youtube_url, description, thumbnail_url, view_count)
        VALUES (%s, %s, %s, 'Newer production title', 'https://youtube.com/watch?v=test',
                'Newer production description', 'https://example.test/existing-thumbnail', 98765)
    """, (video["id"], video["youtube_video_id"], video["channel_name"]))
    conn.execute("""
        INSERT INTO annotation_videos (video_id, title, description, channel_name, source_updated_at)
        VALUES (%s, 'Existing annotation title', 'Existing annotation description', %s, NOW())
    """, (video["id"], video["channel_name"]))


def test_seed_upgrade_preserves_nine_reviews_and_existing_records(seed_database) -> None:
    conn = seed_database
    dataset = load_dataset()
    pairs = dataset["pairs"][:4]
    by_video = {video["id"]: video for video in dataset["videos"]}
    seen = set()
    for pair in pairs:
        if pair["video_id"] not in seen:
            _insert_source(conn, by_video[pair["video_id"]])
            seen.add(pair["video_id"])
    profile_id = dataset["profiles"][0]["id"]
    conn.execute("UPDATE annotation_profiles SET summary = 'Existing revised preference', version = 2 WHERE id = %s", (profile_id,))
    judgments = [("yes", "yes"), ("yes", "no", "unsure"), ("no",), ("no", "no", "unsure")]
    for pair, labels in zip(pairs, judgments):
        for label in labels:
            conn.execute("""
                INSERT INTO annotation_labels (id, profile_id, video_id, annotator_id, label, rationale)
                VALUES (%s, %s, %s, %s, %s, 'Existing human rationale')
            """, (uuid4(), pair["profile_id"], pair["video_id"], uuid4(), label))
    reviews_before = conn.execute("SELECT * FROM annotation_labels ORDER BY id").fetchall()
    videos_before = conn.execute("SELECT * FROM videos ORDER BY id").fetchall()
    snapshots_before = conn.execute("SELECT * FROM annotation_videos ORDER BY video_id").fetchall()
    conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert _counts(conn) == {"profiles": 100, "videos": 296, "snapshots": 296, "pairs": 200, "labels": 9}
    assert conn.execute("SELECT * FROM annotation_labels ORDER BY id").fetchall() == reviews_before
    original_ids = [UUID(identity) for identity in seen]
    assert conn.execute("SELECT * FROM videos WHERE id = ANY(%s) ORDER BY id", (original_ids,)).fetchall() == videos_before
    assert conn.execute("SELECT * FROM annotation_videos WHERE video_id = ANY(%s) ORDER BY video_id", (original_ids,)).fetchall() == snapshots_before
    assert conn.execute("SELECT summary, version FROM annotation_profiles WHERE id = %s", (profile_id,)).fetchone() == {
        "summary": "Existing revised preference", "version": 2,
    }
    for pair, expected in zip(pairs, [("consensus", "yes"), ("escalated", None), ("open", None), ("consensus", "no")]):
        state = conn.execute("SELECT queue_status, consensus_label FROM annotation_pair_scores WHERE profile_id = %s AND video_id = %s", (pair["profile_id"], pair["video_id"])).fetchone()
        assert (state["queue_status"], state["consensus_label"]) == expected


def test_seed_identity_collision_fails_without_overwriting_data(seed_database) -> None:
    conn = seed_database
    video = load_dataset()["videos"][0]
    _insert_source(conn, {**video, "youtube_video_id": "different-existing-youtube-id"})
    before = _counts(conn)
    with pytest.raises(psycopg.errors.RaiseException, match="video identity conflicts"):
        with conn.transaction():
            conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert _counts(conn) == before


def test_seed_maps_existing_youtube_identity_without_overwriting_it(seed_database) -> None:
    conn = seed_database
    dataset = load_dataset()
    pair = dataset["pairs"][0]
    source_video = next(video for video in dataset["videos"] if video["id"] == pair["video_id"])
    existing_id = uuid4()
    _insert_source(conn, {**source_video, "id": str(existing_id)})
    label_id = uuid4()
    conn.execute(
        """
        INSERT INTO annotation_labels (id, profile_id, video_id, annotator_id, label, rationale)
        VALUES (%s, %s, %s, %s, 'yes', 'Existing judgment on the independently ingested video')
        """,
        (label_id, pair["profile_id"], existing_id, uuid4()),
    )
    video_before = conn.execute("SELECT * FROM videos WHERE id = %s", (existing_id,)).fetchone()
    annotation_before = conn.execute(
        "SELECT * FROM annotation_videos WHERE video_id = %s", (existing_id,)
    ).fetchone()
    label_before = conn.execute("SELECT * FROM annotation_labels WHERE id = %s", (label_id,)).fetchone()

    conn.execute(MIGRATION.read_text(encoding="utf-8"))

    assert conn.execute("SELECT * FROM videos WHERE id = %s", (existing_id,)).fetchone() == video_before
    assert conn.execute(
        "SELECT * FROM annotation_videos WHERE video_id = %s", (existing_id,)
    ).fetchone() == annotation_before
    assert conn.execute("SELECT count(*) AS count FROM videos WHERE id = %s", (source_video["id"],)).fetchone()["count"] == 0
    mapped_pairs = conn.execute(
        """
        SELECT snapshot_provenance
        FROM annotation_pair_scores
        WHERE video_id = %s AND snapshot_id = (SELECT id FROM annotation_snapshots)
        """,
        (existing_id,),
    ).fetchall()
    expected_pair_count = sum(item["video_id"] == source_video["id"] for item in dataset["pairs"])
    assert len(mapped_pairs) == expected_pair_count
    assert all(row["snapshot_provenance"]["source_video_id"] == source_video["id"] for row in mapped_pairs)
    assert all(row["snapshot_provenance"]["resolved_video_id"] == str(existing_id) for row in mapped_pairs)
    assert conn.execute("SELECT * FROM annotation_labels WHERE id = %s", (label_id,)).fetchone() == label_before
    assert conn.execute(
        "SELECT provenance->>'identity_mapping' AS policy FROM annotation_snapshots"
    ).fetchone()["policy"] == (
        "Source video UUIDs resolve to existing rows by unique youtube_video_id; otherwise source UUIDs are retained"
    )

    conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert conn.execute("SELECT * FROM videos WHERE id = %s", (existing_id,)).fetchone() == video_before
    assert conn.execute(
        "SELECT * FROM annotation_videos WHERE video_id = %s", (existing_id,)
    ).fetchone() == annotation_before
    assert conn.execute("SELECT * FROM annotation_labels WHERE id = %s", (label_id,)).fetchone() == label_before
    assert _counts(conn) == {"profiles": 100, "videos": 296, "snapshots": 296, "pairs": 200, "labels": 1}
    assert conn.execute("SELECT count(*) AS count FROM annotation_snapshots").fetchone()["count"] == 1
