import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row


MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "database"
    / "migrations"
    / "0009_global_channel_ownership.sql"
)


def test_global_channel_ownership_migration_preserves_video_linkage() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for the PostgreSQL upgrade test")

    survivor_id, duplicate_id = uuid4(), uuid4()
    first_owner, second_owner = uuid4(), uuid4()
    first_video, second_video = uuid4(), uuid4()
    canonical_id = "UC" + "g" * 22

    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        try:
            # Recreate the ownership/index state left by the already-applied 0008
            # migration, then execute 0009 exactly as an upgrade would.
            conn.execute("DROP INDEX IF EXISTS tracked_channels_youtube_channel_idx")
            conn.execute(
                """
                CREATE UNIQUE INDEX tracked_channels_user_youtube_channel_idx
                    ON tracked_channels (user_id, youtube_channel_id)
                    WHERE youtube_channel_id IS NOT NULL
                """
            )
            foreign_keys = conn.execute(
                """
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = 'tracked_channels'::regclass
                  AND confrelid = 'app_users'::regclass
                  AND contype = 'f'
                """
            ).fetchall()
            for row in foreign_keys:
                conn.execute(
                    sql.SQL("ALTER TABLE tracked_channels DROP CONSTRAINT {}").format(
                        sql.Identifier(row["conname"])
                    )
                )

            conn.execute(
                """
                INSERT INTO tracked_channels (
                    id, user_id, name, url, youtube_channel_id, is_default, created_at
                ) VALUES
                    (%s, %s, 'Survivor', 'https://youtube.com/@survivor', %s, TRUE, NOW() - INTERVAL '1 day'),
                    (%s, %s, 'Duplicate', 'https://youtube.com/@duplicate', %s, FALSE, NOW())
                """,
                (survivor_id, first_owner, canonical_id, duplicate_id, second_owner, canonical_id),
            )
            conn.execute(
                """
                INSERT INTO videos (
                    id, youtube_video_id, tracked_channel_id, channel_name, title, youtube_url
                ) VALUES
                    (%s, %s, %s, 'Survivor', 'First', 'https://youtu.be/ownership-first'),
                    (%s, %s, %s, 'Duplicate', 'Second', 'https://youtu.be/ownership-second')
                """,
                (
                    first_video,
                    f"ownership-{first_video}",
                    survivor_id,
                    second_video,
                    f"ownership-{second_video}",
                    duplicate_id,
                ),
            )

            conn.execute(MIGRATION.read_text(encoding="utf-8"))

            channels = conn.execute(
                """
                SELECT id, is_active, youtube_channel_id
                FROM tracked_channels
                WHERE id = ANY(%s)
                ORDER BY id
                """,
                ([survivor_id, duplicate_id],),
            ).fetchall()
            by_id = {row["id"]: row for row in channels}
            assert by_id[survivor_id]["is_active"] is True
            assert by_id[survivor_id]["youtube_channel_id"] == canonical_id
            assert by_id[duplicate_id]["is_active"] is False
            assert by_id[duplicate_id]["youtube_channel_id"] is None

            linked_channels = conn.execute(
                "SELECT DISTINCT tracked_channel_id FROM videos WHERE id = ANY(%s)",
                ([first_video, second_video],),
            ).fetchall()
            assert linked_channels == [{"tracked_channel_id": survivor_id}]

            with pytest.raises(UniqueViolation):
                conn.execute(
                    """
                    INSERT INTO tracked_channels (
                        id, user_id, name, url, youtube_channel_id
                    ) VALUES (%s, %s, 'Rejected', 'https://youtube.com/@rejected', %s)
                    """,
                    (uuid4(), uuid4(), canonical_id),
                )
        finally:
            conn.rollback()
