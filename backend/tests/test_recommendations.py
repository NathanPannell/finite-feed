from datetime import UTC, datetime, timedelta
from uuid import uuid4

from backend.app.recommendations import _score_rows, retrieve_shortlist
from backend.app.settings import Settings


def video(title: str, similarity: float, published_at: datetime, views: int = 1000) -> dict:
    return {
        "id": uuid4(),
        "youtube_video_id": str(uuid4()),
        "title": title,
        "description": "",
        "speaker": None,
        "channel_name": "TED",
        "published_at": published_at,
        "view_count": views,
        "channel_baseline_views": 1000,
        "semantic_similarity": similarity,
    }


def test_scoring_blends_sql_similarity_with_momentum() -> None:
    now = datetime(2026, 9, 2, tzinfo=UTC)
    rows = [
        video("Football psychology", 0.82, now - timedelta(days=2)),
        video("Ceramic glazing", 0.04, now - timedelta(days=1), views=1_000_000),
    ]
    results = _score_rows(rows, now, "recent", 5)
    assert results[0].row["title"] == "Football psychology"
    assert results[0].relevance == 0.82
    assert all(result.pool == "recent" for result in results)


class FakeEmbedder:
    model_name = "semantic-test"
    model_revision = "revision-test"
    dimensions = 384

    def __init__(self) -> None:
        self.queries = []

    def embed_queries(self, texts):
        self.queries.append(list(texts))
        return [[1.0] + [0.0] * 383]


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0]

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, recent_row):
        self.recent_row = recent_row
        self.queries = []

    def execute(self, query, params=()):
        normalized = " ".join(query.split())
        self.queries.append((normalized, params))
        if "COUNT(*) AS count" in normalized:
            return Result([{"count": 0}])
        if normalized.startswith("SET LOCAL"):
            return Result([])
        return Result([self.recent_row] if params[6] is not None else [])


def test_retrieval_uses_query_embedding_and_sql_cosine_distance() -> None:
    now = datetime(2026, 9, 2, tzinfo=UTC)
    row = video("A semantic result", 0.91, now - timedelta(days=1))
    conn = FakeConnection(row)
    embedder = FakeEmbedder()

    results = retrieve_shortlist(
        conn, Settings(_env_file=None), uuid4(), "  a paraphrased preference  ", None,
        now=now, embedder=embedder,
    )

    assert embedder.queries == [["a paraphrased preference"]]
    assert results[0].relevance == 0.91
    nearest_queries = [query for query, _ in conn.queries if "semantic_similarity" in query]
    assert len(nearest_queries) == 2
    assert all(query.count("<=>") == 2 for query in nearest_queries)
    assert all("ORDER BY semantic_embedding <=>" in query for query in nearest_queries)
    assert all("description-v1" not in query for query in nearest_queries)
    nearest_params = [params for query, params in conn.queries if "semantic_similarity" in query]
    assert all(params[4] == "description-v1" for params in nearest_params)
    settings_sql = [query for query, _ in conn.queries if query.startswith("SET LOCAL hnsw")]
    assert settings_sql == [
        "SET LOCAL hnsw.iterative_scan = strict_order",
        "SET LOCAL hnsw.ef_search = 100",
        "SET LOCAL hnsw.max_scan_tuples = 20000",
    ]
