from pathlib import Path


def test_admin_migration_reconciles_legacy_canonical_duplicates_before_unique_index() -> None:
    migration = (
        Path(__file__).resolve().parents[2]
        / "database"
        / "migrations"
        / "0008_admin_operations.sql"
    ).read_text(encoding="utf-8")
    reconcile_at = migration.index("WITH canonical_channel_duplicates")
    unique_index_at = migration.index("CREATE UNIQUE INDEX tracked_channels_user_youtube_channel_idx")
    assert reconcile_at < unique_index_at
    assert "SET is_active = FALSE, youtube_channel_id = NULL" in migration
    assert "DELETE FROM TRACKED_CHANNELS" not in migration.upper()
