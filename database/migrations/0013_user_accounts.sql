ALTER TABLE app_users ADD COLUMN auth_subject TEXT UNIQUE;
ALTER TABLE app_users ADD COLUMN email TEXT;
ALTER TABLE app_users ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE TABLE user_channel_follows (
 user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 channel_id UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (user_id, channel_id)
);
INSERT INTO user_channel_follows(user_id, channel_id)
SELECT user_id, id FROM tracked_channels WHERE is_active;

CREATE TABLE telegram_link_tokens (
 token_hash TEXT PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX telegram_link_tokens_user_idx ON telegram_link_tokens(user_id);
