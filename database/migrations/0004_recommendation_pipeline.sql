ALTER TABLE tracked_channels
    ADD COLUMN uploads_playlist_id TEXT,
    ADD COLUMN last_ingested_at TIMESTAMPTZ;

ALTER TABLE videos
    ADD COLUMN embedding_model TEXT,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE ingestion_runs (
    id UUID PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    channels_scanned INTEGER NOT NULL DEFAULT 0,
    videos_seen INTEGER NOT NULL DEFAULT 0,
    videos_changed INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE INDEX videos_embedding_model_idx ON videos (embedding_model);

UPDATE preference_versions
SET preference_statement = 'I am especially interested in the intersection of psychology and football: decision-making under pressure, team culture, coaching, motivation, attention, and what elite performance reveals about how people think.',
    rendered_markdown = '# Current preferences\n\nI am especially interested in the intersection of psychology and football: decision-making under pressure, team culture, coaching, motivation, attention, and what elite performance reveals about how people think.\n\n## History\n\n- Initial genre-specific dogfood profile.'
WHERE id = '00000000-0000-0000-0000-000000000011';
