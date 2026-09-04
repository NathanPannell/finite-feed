CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE videos
    ADD COLUMN semantic_embedding vector(384),
    ADD COLUMN semantic_embedding_model TEXT,
    ADD COLUMN semantic_embedding_revision TEXT,
    ADD COLUMN semantic_embedding_dimensions SMALLINT,
    ADD COLUMN semantic_embedding_fingerprint TEXT,
    ADD COLUMN semantic_embedding_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN semantic_embedding_last_attempt_at TIMESTAMPTZ,
    ADD COLUMN semantic_embedding_last_error TEXT,
    ADD CONSTRAINT videos_semantic_embedding_dimensions_check
        CHECK (semantic_embedding_dimensions IS NULL OR semantic_embedding_dimensions = 384),
    ADD CONSTRAINT videos_semantic_embedding_attempt_count_check
        CHECK (semantic_embedding_attempt_count >= 0);

CREATE INDEX videos_semantic_embedding_hnsw_idx
    ON videos USING hnsw (semantic_embedding vector_cosine_ops)
    WHERE semantic_embedding IS NOT NULL;

CREATE INDEX videos_semantic_embedding_backfill_idx
    ON videos (semantic_embedding_last_attempt_at, ingested_at, id);
