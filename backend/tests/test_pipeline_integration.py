import os
from datetime import UTC, datetime
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from backend.app.ingestion import ingest_tracked_channels
from backend.app.recommendations import generate_recommendation
from backend.app.settings import Settings
from backend.app.youtube import ChannelDetails, YouTubeVideo

USER_ID = UUID("00000000-0000-0000-0000-000000000001")


class FakeYouTube:
    def resolve_channel(self, url: str, known_id: str | None = None) -> ChannelDetails:
        slug = "tedx" if "tedx" in url.lower() else "ted"
        name = "TEDx" if slug == "tedx" else "TED"
        return ChannelDetails(slug, name, f"uploads-{slug}")

    def list_uploads(self, playlist_id: str, page_limit: int = 2) -> list[YouTubeVideo]:
        relevant = playlist_id.endswith("ted")
        video_id = "test-football-psychology" if relevant else "test-pottery"
        title = "The psychology of football decisions | Casey Coach | TED" if relevant else "The chemistry of pottery | Pat Potter | TEDx"
        description = "How pressure, motivation, and team culture shape elite football." if relevant else "A tour of ceramic glazes and kilns."
        return [YouTubeVideo(
            video_id, "TED" if relevant else "TEDx", title, "Casey Coach" if relevant else "Pat Potter",
            f"https://www.youtube.com/watch?v={video_id}", None, description,
            datetime(2026, 9, 1, tzinfo=UTC), 900, 1000,
        )]


def test_ingest_retrieve_and_persist_recommendation() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute("DELETE FROM recommendations")
        conn.execute("DELETE FROM videos WHERE youtube_video_id LIKE 'test-%'")
        conn.commit()
        summary = ingest_tracked_channels(conn, FakeYouTube(), page_limit=1)
        assert summary.channels_scanned == 2
        assert summary.videos_changed == 2
        recommendation_id = generate_recommendation(conn, Settings(DATABASE_URL=database_url), USER_ID)
        row = conn.execute(
            "SELECT v.title, r.evidence FROM recommendations r JOIN videos v ON v.id = r.video_id WHERE r.id = %s",
            (recommendation_id,),
        ).fetchone()
        assert "football" in row["title"].lower()
        assert row["evidence"]["pipeline"] == "vector-retrieval-openrouter-rerank-v1"
