ALTER TABLE tracked_channels
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN max_video_age_days SMALLINT NOT NULL DEFAULT 7,
    ADD COLUMN thumbnail_url TEXT,
    ADD COLUMN description TEXT NOT NULL DEFAULT '',
    ADD COLUMN subscriber_count BIGINT,
    ADD COLUMN public_video_count BIGINT,
    ADD COLUMN metadata_updated_at TIMESTAMPTZ,
    ADD COLUMN last_sync_started_at TIMESTAMPTZ,
    ADD COLUMN last_sync_completed_at TIMESTAMPTZ,
    ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN sync_error TEXT,
    ADD COLUMN backfill_page_token TEXT,
    ADD COLUMN backfill_oldest_published_at TIMESTAMPTZ,
    ADD COLUMN backfill_completed_at TIMESTAMPTZ,
    ADD CONSTRAINT tracked_channels_max_video_age_days_check
        CHECK (max_video_age_days BETWEEN 1 AND 365),
    ADD CONSTRAINT tracked_channels_sync_status_check
        CHECK (sync_status IN ('idle', 'running', 'completed', 'failed')),
    ADD CONSTRAINT tracked_channels_subscriber_count_check
        CHECK (subscriber_count IS NULL OR subscriber_count >= 0),
    ADD CONSTRAINT tracked_channels_public_video_count_check
        CHECK (public_video_count IS NULL OR public_video_count >= 0);

-- Older installs allowed the same canonical channel to be stored under different URLs.
-- Keep every legacy row, but retain the canonical ID and active state only on the
-- deterministic survivor so the new uniqueness guarantee can be created safely.
WITH canonical_channel_duplicates AS (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY user_id, youtube_channel_id
        ORDER BY is_default DESC, created_at, id
    ) AS occurrence
    FROM tracked_channels
    WHERE youtube_channel_id IS NOT NULL
)
UPDATE tracked_channels
SET is_active = FALSE, youtube_channel_id = NULL
WHERE id IN (
    SELECT id FROM canonical_channel_duplicates WHERE occurrence > 1
);

ALTER TABLE videos
    ADD COLUMN tracked_channel_id UUID REFERENCES tracked_channels(id) ON DELETE SET NULL;

WITH unique_channel_names AS (
    SELECT LOWER(name) AS normalized_name, MIN(id::TEXT)::UUID AS channel_id
    FROM tracked_channels
    WHERE is_active = TRUE
    GROUP BY LOWER(name)
    HAVING COUNT(*) = 1
)
UPDATE videos
SET tracked_channel_id = unique_channel_names.channel_id
FROM unique_channel_names
WHERE LOWER(videos.channel_name) = unique_channel_names.normalized_name
  AND videos.tracked_channel_id IS NULL;

CREATE TABLE admin_audit_events (
    id UUID PRIMARY KEY,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID NOT NULL,
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    actor TEXT,
    before_values JSONB NOT NULL DEFAULT '{}'::JSONB,
    after_values JSONB NOT NULL DEFAULT '{}'::JSONB,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX tracked_channels_user_youtube_channel_idx
    ON tracked_channels (user_id, youtube_channel_id)
    WHERE youtube_channel_id IS NOT NULL;
CREATE INDEX tracked_channels_active_created_idx
    ON tracked_channels (is_active, created_at DESC);
CREATE INDEX tracked_channels_sync_completed_idx
    ON tracked_channels (last_sync_completed_at DESC);
CREATE INDEX tracked_channels_sync_status_idx
    ON tracked_channels (sync_status, last_sync_started_at DESC);
CREATE INDEX videos_tracked_channel_published_idx
    ON videos (tracked_channel_id, published_at DESC);
CREATE INDEX videos_ingested_at_idx
    ON videos (ingested_at DESC);
CREATE INDEX recommendations_delivery_created_idx
    ON recommendations (delivered_at, created_at DESC);
CREATE INDEX admin_audit_events_created_idx
    ON admin_audit_events (created_at DESC);
CREATE INDEX admin_audit_events_target_idx
    ON admin_audit_events (target_type, target_id, created_at DESC);
