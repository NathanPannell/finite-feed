CREATE TABLE annotation_annotators (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'google'),
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NULL,
    image_url TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issuer, subject)
);

CREATE INDEX annotation_annotators_email_idx ON annotation_annotators (email);
