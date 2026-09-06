ALTER TABLE telegram_link_tokens
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'deep_link'
        CHECK (kind IN ('deep_link', 'manual_code'));

CREATE TABLE telegram_link_attempts (
    chat_id BIGINT PRIMARY KEY,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0)
);

CREATE TABLE telegram_preference_confirmations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL,
    proposed_text TEXT NOT NULL CHECK (char_length(proposed_text) BETWEEN 1 AND 4096),
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    accepted BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((resolved_at IS NULL AND accepted IS NULL) OR
           (resolved_at IS NOT NULL AND accepted IS NOT NULL))
);
CREATE INDEX telegram_preference_confirmations_user_chat_idx
    ON telegram_preference_confirmations(user_id, chat_id, created_at DESC);
