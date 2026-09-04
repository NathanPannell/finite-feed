from pathlib import Path


def test_global_channel_ownership_migration_preserves_video_linkage() -> None:
    migration = (
        Path(__file__).resolve().parents[2]
        / "database"
        / "migrations"
        / "0009_global_channel_ownership.sql"
    ).read_text(encoding="utf-8")
    assert "PARTITION BY youtube_channel_id" in migration
    assert "SET tracked_channel_id = duplicates.survivor_id" in migration
    assert "SET is_active = FALSE, youtube_channel_id = NULL" in migration
    assert "DROP INDEX IF EXISTS tracked_channels_user_youtube_channel_idx" in migration
    assert "ON tracked_channels (youtube_channel_id)" in migration
    assert "DELETE FROM TRACKED_CHANNELS" not in migration.upper()
