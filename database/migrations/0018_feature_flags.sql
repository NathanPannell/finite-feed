CREATE TABLE app_feature_flags (
    key TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT
);

INSERT INTO app_feature_flags (key, enabled)
VALUES ('match_lab_homepage_visible', TRUE);
