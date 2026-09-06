ALTER TABLE app_users ADD COLUMN onboarding_completed_at TIMESTAMPTZ;

-- Preserve configured accounts while sending accounts that still have the
-- first-login placeholder (or no profile) through the new workflow.
UPDATE app_users u
SET onboarding_completed_at = NOW()
WHERE (
    SELECT preference_statement
    FROM preference_versions p
    WHERE p.user_id = u.id
    ORDER BY p.version DESC
    LIMIT 1
) IS DISTINCT FROM 'Show me unusually useful ideas. I will add my interests and exclusions in settings.'
AND EXISTS (SELECT 1 FROM preference_versions p WHERE p.user_id = u.id);

CREATE TABLE onboarding_sessions (
    user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    answers JSONB NOT NULL DEFAULT '{}'::JSONB,
    open_response TEXT,
    draft_profile TEXT,
    draft_model TEXT,
    synthesized_at TIMESTAMPTZ,
    profile_accepted_at TIMESTAMPTZ,
    delivery_saved_at TIMESTAMPTZ,
    telegram_choice TEXT CHECK (telegram_choice IN ('connected', 'skipped')),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE onboarding_audit_logs (
    id UUID PRIMARY KEY,
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX onboarding_audit_logs_user_created_idx
    ON onboarding_audit_logs (user_id, sequence);
