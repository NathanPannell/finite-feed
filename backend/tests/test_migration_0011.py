from pathlib import Path


def test_match_lab_migration_is_append_only_and_does_not_reset_data() -> None:
    migration = (
        Path(__file__).resolve().parents[2]
        / "database"
        / "migrations"
        / "0011_match_lab_curated_queue.sql"
    ).read_text(encoding="utf-8")
    assert "DELETE FROM" not in migration.upper()
    assert "DROP TABLE" not in migration.upper()
    assert "annotation_snapshots" in migration
    assert "snapshot_provenance" in migration


def test_replace_tool_locks_review_tables_before_export_and_delete() -> None:
    tool = (
        Path(__file__).resolve().parents[1] / "tools" / "match_lab.py"
    ).read_text(encoding="utf-8")
    lock_at = tool.index("LOCK TABLE annotation_pair_scores, annotation_labels")
    export_at = tool.index('"annotation_labels": conn.execute')
    delete_at = tool.index('conn.execute("DELETE FROM annotation_labels')
    assert lock_at < export_at < delete_at
