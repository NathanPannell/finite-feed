ALTER TABLE app_users ADD COLUMN delivery_paused BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN delivery_status TEXT, ADD COLUMN delivery_error TEXT;
ALTER TABLE videos ADD COLUMN is_available BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE provider_daily_usage (
    provider TEXT NOT NULL, usage_date DATE NOT NULL, requests INTEGER NOT NULL,
    PRIMARY KEY (provider, usage_date)
);
CREATE TABLE worker_heartbeat (
    worker TEXT PRIMARY KEY, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL, error TEXT
);
-- Broad, established educational sources; imports remain bounded by worker budgets.
INSERT INTO tracked_channels (id, user_id, name, url, is_default, max_video_age_days)
SELECT gen_random_uuid(), u.id, source.name, source.url, TRUE, 365
FROM (SELECT id FROM app_users ORDER BY created_at, id LIMIT 1) u
CROSS JOIN (VALUES
    ('Big Think', 'https://www.youtube.com/@bigthink'),
    ('The Royal Institution', 'https://www.youtube.com/@TheRoyalInstitution'),
    ('Stanford Graduate School of Business', 'https://www.youtube.com/@stanfordgsb')
) source(name, url)
ON CONFLICT DO NOTHING;
UPDATE tracked_channels SET max_video_age_days = 365, backfill_completed_at = NULL
WHERE is_default AND max_video_age_days = 7;
