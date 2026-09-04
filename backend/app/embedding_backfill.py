from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from psycopg import Connection

EMBEDDING_DIMENSIONS = 384


class DocumentEmbedder(Protocol):
    model_name: str
    model_revision: str
    dimensions: int

    def embed_documents(self, texts: Sequence[str]) -> Sequence[Sequence[float]]: ...


@dataclass(frozen=True)
class BackfillSummary:
    batches: int = 0
    attempted: int = 0
    embedded: int = 0
    failed: int = 0


def document_text(title: str, description: str) -> str:
    """Build the canonical text passed to document (not query) encoding."""
    normalized_title = re.sub(r"\s+", " ", title).strip()
    normalized_description = re.sub(r"\s+", " ", description).strip()
    return f"{normalized_title}\n{normalized_description}"


def backfill_embeddings(
    conn: Connection,
    embedder: DocumentEmbedder,
    *,
    batch_size: int = 32,
    retry_delay_minutes: int = 5,
) -> BackfillSummary:
    """Backfill stale semantic embeddings in retryable, concurrency-safe batches.

    Each batch is locked until its vectors or failure telemetry are committed. Other
    workers skip those locks, so multiple backfill processes can run concurrently.
    """
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1")
    if retry_delay_minutes < 0:
        raise ValueError("retry_delay_minutes cannot be negative")
    if embedder.dimensions != EMBEDDING_DIMENSIONS:
        raise ValueError(
            f"embedder dimensions must be {EMBEDDING_DIMENSIONS}, got {embedder.dimensions}"
        )
    if not embedder.model_name or not embedder.model_revision:
        raise ValueError("embedder model_name and model_revision must be exact, non-empty values")

    summary = BackfillSummary()
    attempted_ids = []
    while True:
        rows = conn.execute(
            """
            SELECT id, title, description, content_fingerprint
            FROM videos
            WHERE (
                  semantic_embedding IS NULL
                  OR semantic_embedding_model IS DISTINCT FROM %s
                  OR semantic_embedding_revision IS DISTINCT FROM %s
                  OR semantic_embedding_dimensions IS DISTINCT FROM %s
                  OR semantic_embedding_fingerprint IS DISTINCT FROM content_fingerprint
              )
              AND (semantic_embedding_last_attempt_at IS NULL
                   OR semantic_embedding_last_attempt_at <= NOW() - (%s * INTERVAL '1 minute'))
              AND (cardinality(%s::uuid[]) = 0 OR id <> ALL(%s::uuid[]))
            ORDER BY ingested_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT %s
            """,
            (
                embedder.model_name,
                embedder.model_revision,
                embedder.dimensions,
                retry_delay_minutes,
                list(attempted_ids),
                list(attempted_ids),
                batch_size,
            ),
        ).fetchall()
        if not rows:
            conn.rollback()
            return summary

        ids = [row["id"] for row in rows]
        attempted_ids.extend(ids)
        conn.execute(
            """
            UPDATE videos
            SET semantic_embedding_attempt_count = semantic_embedding_attempt_count + 1,
                semantic_embedding_last_attempt_at = NOW()
            WHERE id = ANY(%s)
            """,
            (ids,),
        )
        summary = BackfillSummary(
            batches=summary.batches + 1,
            attempted=summary.attempted + len(rows),
            embedded=summary.embedded,
            failed=summary.failed,
        )

        try:
            vectors = embedder.embed_documents(
                [document_text(row["title"], row["description"] or "") for row in rows]
            )
            if len(vectors) != len(rows):
                raise ValueError(
                    f"embedder returned {len(vectors)} vectors for {len(rows)} documents"
                )
            vector_literals = [_vector_literal(vector, embedder.dimensions) for vector in vectors]
        except Exception as exc:
            error = _error_message(exc)
            conn.execute(
                """
                UPDATE videos
                SET semantic_embedding_last_error = %s
                WHERE id = ANY(%s)
                """,
                (error, ids),
            )
            conn.commit()
            summary = BackfillSummary(
                batches=summary.batches,
                attempted=summary.attempted,
                embedded=summary.embedded,
                failed=summary.failed + len(rows),
            )
            continue

        embedded_count = 0
        for row, vector_literal in zip(rows, vector_literals, strict=True):
            result = conn.execute(
                """
                UPDATE videos
                SET semantic_embedding = %s::vector,
                    semantic_embedding_model = %s,
                    semantic_embedding_revision = %s,
                    semantic_embedding_dimensions = %s,
                    semantic_embedding_fingerprint = %s,
                    semantic_embedding_last_error = NULL
                WHERE id = %s
                  AND content_fingerprint IS NOT DISTINCT FROM %s
                """,
                (
                    vector_literal,
                    embedder.model_name,
                    embedder.model_revision,
                    embedder.dimensions,
                    row["content_fingerprint"],
                    row["id"],
                    row["content_fingerprint"],
                ),
            )
            embedded_count += result.rowcount
        conn.commit()
        summary = BackfillSummary(
            batches=summary.batches,
            attempted=summary.attempted,
            embedded=summary.embedded + embedded_count,
            failed=summary.failed,
        )


def _vector_literal(vector: Sequence[float], dimensions: int) -> str:
    if len(vector) != dimensions:
        raise ValueError(f"embedding has {len(vector)} dimensions; expected {dimensions}")
    values = [float(value) for value in vector]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("embedding contains a non-finite value")
    return "[" + ",".join(format(value, ".17g") for value in values) + "]"


def _error_message(exc: Exception) -> str:
    message = f"{type(exc).__name__}: {exc}"
    return message[:2000]
