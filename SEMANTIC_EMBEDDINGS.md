# Semantic embedding rollout

Finite Feed uses `Snowflake/snowflake-arctic-embed-xs` at revision
`d8c86521100d3556476a063fc2342036d45c106f`. The model produces 384-dimensional
vectors and runs inside each Railway process. Images download that exact revision at
build time, then set Hugging Face and Transformers offline modes at runtime. No
embedding API, credential, hosted inference call, or per-token service is used.

## Rollout and verification

Migration `0008_semantic_embeddings.sql` enables pgvector, adds a new
`semantic_embedding vector(384)` column and exact model metadata, and creates the
HNSW cosine index. It deliberately leaves the legacy `embedding REAL[]` data intact.
The worker claims stale rows with `FOR UPDATE SKIP LOCKED`, embeds documents in
batches, records failures, and retries them after a delay. New and changed videos are
embedded in the ingestion transaction.

`GET /api/pipeline/status` is the rollout gate. Semantic retrieval refuses to run
until `embedding_backfill_remaining` is zero for the configured model, revision,
dimension, and content fingerprints. Verify `embedding_failures` is zero, then run a
recommendation and confirm its evidence reports
`pgvector-cosine-openrouter-rerank-v2` and the pinned revision.

Run `python -m backend.evals.benchmark_embeddings` inside the Railway API and worker
images to record CPU time, resident memory, cold-start time, and throughput for batch
sizes 1, 8, and 32. Use `EMBEDDING_BATCH_SIZE` to tune within the measured memory
budget; keep one cached model instance per process.

Pre-preview Linux container measurements with networking disabled provide the
deployment baseline: the worker used 531 MB RSS with a 5.02-second cold start and
processed batches of 1, 8, and 32 at 61, 178, and 311 documents/second. The API used
542 MB RSS with a 4.72-second cold start and reached 106, 174, and 299
documents/second. Record the same command's Railway preview output in the PR before
merge and compare it with this baseline.

## Rollback

Redeploy the preceding application commit without reverting migration 0008. Its
feature-hash code continues to read the untouched legacy columns while PostgreSQL
ignores the additive semantic columns. Do not drop the legacy columns or vectors
until production and a preview have both reported a complete backfill and stable
resource use over an observation window. A later append-only cleanup migration may
remove them after that verification.
