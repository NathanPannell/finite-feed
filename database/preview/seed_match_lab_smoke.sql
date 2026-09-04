-- Preview-only deterministic fixture used to exercise the deployed Match Lab path.
-- The Neon preview branch is isolated and expires automatically.
BEGIN;

INSERT INTO annotation_snapshots (
    id, snapshot_sha256, source_commit, source_migrations,
    profile_count, video_count, pair_count, provenance
)
SELECT
    '41000000-0000-4000-8000-000000000018',
    repeat('18', 32),
    'preview-smoke',
    ARRAY['0010_match_lab_curated_queue.sql'],
    (SELECT COUNT(*) FROM annotation_profiles WHERE active),
    (SELECT COUNT(*) FROM annotation_videos),
    (SELECT COUNT(*) FROM annotation_profiles WHERE active) * (SELECT COUNT(*) FROM annotation_videos),
    '{"purpose":"preview-smoke"}'::jsonb
ON CONFLICT (id) DO UPDATE SET provenance = EXCLUDED.provenance;

WITH chosen AS (
    SELECT profile.id AS profile_id, video.video_id
    FROM annotation_profiles profile
    CROSS JOIN annotation_videos video
    WHERE profile.active
    ORDER BY profile.id, video.video_id
    LIMIT 1
)
DELETE FROM annotation_labels labels
USING chosen
WHERE labels.profile_id = chosen.profile_id AND labels.video_id = chosen.video_id;

WITH chosen AS (
    SELECT profile.id AS profile_id, video.video_id
    FROM annotation_profiles profile
    CROSS JOIN annotation_videos video
    WHERE profile.active
    ORDER BY profile.id, video.video_id
    LIMIT 1
)
INSERT INTO annotation_pair_scores (
    profile_id, video_id, relevance_score, difficulty_score, scoring_model,
    curated, predicted_fit, close_call, selection_rationale, decision_summary,
    scoring_model_version, snapshot_id, snapshot_provenance,
    queue_status, consensus_label, last_served_at
)
SELECT
    profile_id, video_id, 0.75, 0.50, 'preview-smoke',
    TRUE, 'yes', FALSE, 'Deterministic isolated-preview fixture for end-to-end validation.',
    'Topic and description evidence suggest a useful match.',
    'preview-smoke-v1', '41000000-0000-4000-8000-000000000018',
    jsonb_build_object(
        'stable_id', profile_id::text || ':' || video_id::text,
        'topic_area', 'preview validation',
        'category', 'strong_match',
        'snapshot_sha256', repeat('18', 32)
    ),
    'open', NULL, NULL
FROM chosen
ON CONFLICT (profile_id, video_id) DO UPDATE SET
    curated = TRUE,
    predicted_fit = EXCLUDED.predicted_fit,
    close_call = EXCLUDED.close_call,
    selection_rationale = EXCLUDED.selection_rationale,
    decision_summary = EXCLUDED.decision_summary,
    scoring_model = EXCLUDED.scoring_model,
    scoring_model_version = EXCLUDED.scoring_model_version,
    snapshot_id = EXCLUDED.snapshot_id,
    snapshot_provenance = EXCLUDED.snapshot_provenance,
    queue_status = 'open',
    consensus_label = NULL,
    last_served_at = NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM annotation_pair_scores
        WHERE curated AND snapshot_id = '41000000-0000-4000-8000-000000000018'
    ) THEN
        RAISE EXCEPTION 'Preview Match Lab fixture could not be seeded';
    END IF;
END $$;

COMMIT;
