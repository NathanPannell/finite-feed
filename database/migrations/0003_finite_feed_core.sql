CREATE TABLE app_users (
    id UUID PRIMARY KEY,
    display_name TEXT NOT NULL,
    telegram_user_id BIGINT UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    cadence_days SMALLINT[] NOT NULL DEFAULT ARRAY[1, 4]::SMALLINT[],
    delivery_hour SMALLINT NOT NULL DEFAULT 9 CHECK (delivery_hour BETWEEN 0 AND 23),
    recommendation_count SMALLINT NOT NULL DEFAULT 1 CHECK (recommendation_count BETWEEN 1 AND 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE preference_versions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    preference_statement TEXT NOT NULL,
    rendered_markdown TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('onboarding', 'dashboard', 'telegram', 'feedback')),
    source_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, version)
);

CREATE TABLE tracked_channels (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    youtube_channel_id TEXT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, url)
);

CREATE TABLE videos (
    id UUID PRIMARY KEY,
    youtube_video_id TEXT NOT NULL UNIQUE,
    channel_name TEXT NOT NULL,
    title TEXT NOT NULL,
    speaker TEXT,
    youtube_url TEXT NOT NULL,
    thumbnail_url TEXT,
    description TEXT NOT NULL DEFAULT '',
    transcript TEXT,
    published_at TIMESTAMPTZ,
    duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    view_count BIGINT NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    channel_baseline_views BIGINT NOT NULL DEFAULT 1 CHECK (channel_baseline_views > 0),
    content_fingerprint TEXT,
    embedding REAL[],
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recommendations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE RESTRICT,
    rationale TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    rating TEXT CHECK (rating IN ('up', 'down')),
    clicked_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, video_id)
);

CREATE TABLE interaction_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('delivery', 'clicked', 'feedback_up', 'feedback_down', 'written_reply', 'preference_revision', 'channel_add', 'channel_remove')),
    source TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE telegram_updates (
    update_id BIGINT PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX recommendations_user_created_idx ON recommendations (user_id, created_at DESC);
CREATE INDEX interaction_events_user_created_idx ON interaction_events (user_id, created_at DESC);
CREATE INDEX videos_published_at_idx ON videos (published_at DESC);

INSERT INTO app_users (id, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Nathan');

INSERT INTO preference_versions (id, user_id, version, preference_statement, rendered_markdown, source)
VALUES (
    '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000001',
    1,
    'Show me unusually useful ideas that challenge how I think and can change what I do.',
    '# Current preferences\n\nShow me unusually useful ideas that challenge how I think and can change what I do.\n\n## History\n\n- Initial onboarding profile.',
    'onboarding'
);

INSERT INTO tracked_channels (id, user_id, name, url, is_default)
VALUES
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', 'TED', 'https://www.youtube.com/@TED', TRUE),
    ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', 'TEDx Talks', 'https://www.youtube.com/@TEDx', TRUE);
