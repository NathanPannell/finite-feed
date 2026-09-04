from pathlib import Path
from uuid import UUID

import pytest

from backend.app.embedding_backfill import EMBEDDING_DIMENSIONS, backfill_embeddings
from backend.app.embedding_backfill import document_text


class _Result:
    def __init__(self, rows=None, rowcount: int = 0):
        self._rows = rows or []
        self.rowcount = rowcount

    def fetchall(self):
        return self._rows


class FakeConnection:
    def __init__(self, claimed_batches):
        self.claimed_batches = list(claimed_batches)
        self.executions = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, query, params=()):
        normalized = " ".join(query.split())
        self.executions.append((normalized, params))
        if normalized.startswith("SELECT id, title"):
            return _Result(self.claimed_batches.pop(0))
        return _Result(rowcount=1)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class FakeEmbedder:
    model_name = "Snowflake/snowflake-arctic-embed-xs"
    model_revision = "0123456789abcdef"
    dimensions = EMBEDDING_DIMENSIONS

    def __init__(self, failures: int = 0):
        self.failures = failures
        self.calls = []

    def embed_documents(self, texts):
        self.calls.append(list(texts))
        if self.failures:
            self.failures -= 1
            raise RuntimeError("temporary model failure")
        return [[0.25] * self.dimensions for _ in texts]


VIDEO_ID = UUID("10000000-0000-0000-0000-000000000001")
VIDEO = {
    "id": VIDEO_ID,
    "title": "  A useful title ",
    "description": " A useful description  ",
    "content_fingerprint": "sha256:abc",
}


def test_backfill_claims_locked_batch_and_records_exact_metadata() -> None:
    conn = FakeConnection([[VIDEO], []])
    embedder = FakeEmbedder()

    summary = backfill_embeddings(conn, embedder, batch_size=8)

    assert summary.batches == 1
    assert summary.attempted == summary.embedded == 1
    assert summary.failed == 0
    assert embedder.calls == [["A useful title\nA useful description"]]
    claim_sql, claim_params = conn.executions[0]
    assert "FOR UPDATE SKIP LOCKED" in claim_sql
    assert claim_params == (
        embedder.model_name,
        embedder.model_revision,
        384,
        "description-v4",
        5,
        [],
        [],
        8,
    )
    vector_updates = [item for item in conn.executions if "SET semantic_embedding = %s::vector" in item[0]]
    assert len(vector_updates) == 1
    _, params = vector_updates[0]
    assert params[1:5] == (
        embedder.model_name,
        embedder.model_revision,
        embedder.dimensions,
        "description-v4:" + VIDEO["content_fingerprint"],
    )
    assert conn.commits == 1


def test_document_text_uses_cleaned_description_for_scoring() -> None:
    assert document_text(
        "A useful title",
        "A useful explanation.\nSubscribe: https://example.com\n#TED",
    ) == "A useful title\nA useful explanation."


def test_backfill_persists_failure_telemetry_for_a_later_retry() -> None:
    conn = FakeConnection([[VIDEO], []])
    embedder = FakeEmbedder(failures=1)

    summary = backfill_embeddings(conn, embedder)

    assert summary.batches == 1
    assert summary.attempted == 1
    assert summary.embedded == 0
    assert summary.failed == 1
    assert conn.commits == 1
    errors = [params for sql, params in conn.executions if "SET semantic_embedding_last_error = %s" in sql]
    assert errors == [("RuntimeError: temporary model failure", [VIDEO_ID])]


def test_backfill_rejects_wrong_vector_dimensions_and_records_failure() -> None:
    class WrongSizeEmbedder(FakeEmbedder):
        def embed_documents(self, texts):
            return [[0.0] * (self.dimensions - 1) for _ in texts]

    conn = FakeConnection([[VIDEO], []])

    summary = backfill_embeddings(conn, WrongSizeEmbedder())

    assert summary.embedded == 0
    assert summary.failed == 1
    errors = [params[0] for sql, params in conn.executions if "semantic_embedding_last_error = %s" in sql]
    assert errors == ["ValueError: embedding has 383 dimensions; expected 384"]


def test_semantic_embedding_migration_preserves_legacy_columns() -> None:
    migration = (
        Path(__file__).resolve().parents[2]
        / "database"
        / "migrations"
        / "0008_semantic_embeddings.sql"
    ).read_text(encoding="utf-8")

    assert "CREATE EXTENSION IF NOT EXISTS vector" in migration
    assert "semantic_embedding vector(384)" in migration
    assert "semantic_embedding_model TEXT" in migration
    assert "semantic_embedding_revision TEXT" in migration
    assert "semantic_embedding_fingerprint TEXT" in migration
    assert "USING hnsw (semantic_embedding vector_cosine_ops)" in migration
    assert "DROP COLUMN embedding" not in migration


@pytest.mark.parametrize("batch_size,retry_delay_minutes", [(0, 5), (1, -1)])
def test_backfill_rejects_invalid_limits(batch_size: int, retry_delay_minutes: int) -> None:
    with pytest.raises(ValueError):
        backfill_embeddings(
            FakeConnection([]), FakeEmbedder(), batch_size=batch_size,
            retry_delay_minutes=retry_delay_minutes,
        )
