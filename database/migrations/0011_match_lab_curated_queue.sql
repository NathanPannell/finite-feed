CREATE TABLE annotation_snapshots (
    id UUID PRIMARY KEY,
    snapshot_sha256 TEXT NOT NULL UNIQUE CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    source_commit TEXT NOT NULL,
    source_migrations TEXT[] NOT NULL DEFAULT '{}',
    profile_count INTEGER NOT NULL CHECK (profile_count >= 0),
    video_count INTEGER NOT NULL CHECK (video_count >= 0),
    pair_count INTEGER NOT NULL CHECK (pair_count >= 0),
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE annotation_pair_scores
    ADD COLUMN curated BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN predicted_fit TEXT NULL CHECK (predicted_fit IN ('yes', 'no', 'unsure')),
    ADD COLUMN close_call BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN selection_rationale TEXT NULL CHECK (
        selection_rationale IS NULL OR char_length(selection_rationale) BETWEEN 1 AND 500
    ),
    ADD COLUMN decision_summary TEXT NULL CHECK (
        decision_summary IS NULL OR char_length(decision_summary) BETWEEN 1 AND 160
    ),
    ADD COLUMN scoring_model_version TEXT NULL,
    ADD COLUMN snapshot_id UUID NULL REFERENCES annotation_snapshots(id) ON DELETE RESTRICT,
    ADD COLUMN snapshot_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN queue_status TEXT NOT NULL DEFAULT 'open' CHECK (
        queue_status IN ('open', 'consensus', 'escalated')
    ),
    ADD COLUMN consensus_label TEXT NULL CHECK (consensus_label IN ('yes', 'no', 'unsure')),
    ADD COLUMN last_served_at TIMESTAMPTZ NULL;

ALTER TABLE annotation_pair_scores
    ADD CONSTRAINT annotation_curated_pair_metadata CHECK (
        NOT curated OR (
            predicted_fit IS NOT NULL
            AND selection_rationale IS NOT NULL
            AND decision_summary IS NOT NULL
            AND scoring_model_version IS NOT NULL
            AND snapshot_id IS NOT NULL
        )
    ),
    ADD CONSTRAINT annotation_consensus_state CHECK (
        (queue_status = 'consensus' AND consensus_label IS NOT NULL)
        OR (queue_status <> 'consensus' AND consensus_label IS NULL)
    );

CREATE INDEX annotation_curated_queue_idx
    ON annotation_pair_scores (queue_status, curated, last_served_at NULLS FIRST)
    WHERE curated;
