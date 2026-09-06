ALTER TABLE recommendations
    ADD COLUMN preference_version_id UUID REFERENCES preference_versions(id) ON DELETE SET NULL;

UPDATE recommendations r
SET preference_version_id = (
    SELECT p.id FROM preference_versions p
    WHERE p.user_id = r.user_id AND p.created_at <= r.created_at
    ORDER BY p.version DESC LIMIT 1
)
WHERE r.preference_version_id IS NULL;

CREATE TABLE telegram_recommendation_queue (
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 2),
    preference_version_id UUID NOT NULL REFERENCES preference_versions(id) ON DELETE CASCADE,
    recommendation_id UUID UNIQUE REFERENCES recommendations(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'ready')),
    generation_token UUID,
    lease_expires_at TIMESTAMPTZ,
    retry_after TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, slot)
);

CREATE INDEX telegram_recommendation_queue_refill_idx
ON telegram_recommendation_queue (status, retry_after, lease_expires_at);
