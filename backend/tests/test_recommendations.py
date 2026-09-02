from datetime import UTC, datetime, timedelta
from uuid import uuid4

from backend.app.embeddings import embed_text
from backend.app.recommendations import retrieve_shortlist


def video(title: str, description: str, published_at: datetime, views: int = 1000) -> dict:
    return {
        "id": uuid4(),
        "youtube_video_id": str(uuid4()),
        "title": title,
        "description": description,
        "speaker": None,
        "channel_name": "TED",
        "published_at": published_at,
        "view_count": views,
        "channel_baseline_views": 1000,
        "embedding": embed_text(f"{title}\n{description}"),
    }


def test_retrieval_combines_recent_and_evergreen_candidates() -> None:
    now = datetime(2026, 9, 2, tzinfo=UTC)
    rows = [
        video("Football psychology", "Decision-making under pressure", now - timedelta(days=2)),
        video("Coaching team culture", "Motivation in elite football", now - timedelta(days=200)),
        video("Ceramic glazing", "How to fire a kiln", now - timedelta(days=1), views=1_000_000),
    ]
    results = retrieve_shortlist(rows, "football psychology coaching motivation", None, now)
    assert {result.pool for result in results} == {"recent", "evergreen"}
    assert results[0].row["title"] == "Football psychology"
