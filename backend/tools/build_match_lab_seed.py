"""Build the immutable, additive Match Lab sample migration from reviewed artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5


ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "database" / "datasets" / "match-lab-v2"
MIGRATION = ROOT / "database" / "migrations" / "0012_match_lab_golden_seed.sql"
CATEGORIES = {"strong_match": 50, "close_call": 60, "near_miss": 40, "hard_negative": 50}


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_dataset(directory: Path = DATASET) -> dict:
    source = json.loads((directory / "source-snapshot.json").read_text(encoding="utf-8"))
    shards = [json.loads((directory / name).read_text(encoding="utf-8")) for name in (
        "curation-01-50.json", "curation-51-100.json",
    )]
    profiles = sorted([profile for shard in shards for profile in shard["profiles"]], key=lambda row: row["id"])
    pairs = sorted([pair for shard in shards for pair in shard["pairs"]], key=lambda row: (row["profile_id"], row["video_id"]))
    videos = sorted(source["videos"], key=lambda row: row["id"])
    if len(profiles) != 100 or len(videos) != 296 or len(pairs) != 200:
        raise ValueError("Seed must contain 100 profiles, 296 source videos, and 200 pairs")
    profile_ids = {row["id"] for row in profiles}
    video_ids = {row["id"] for row in videos}
    if len(profile_ids) != 100 or len(video_ids) != 296 or len({v["youtube_video_id"] for v in videos}) != 296:
        raise ValueError("Profile and video identities must be unique")
    if len({(row["profile_id"], row["video_id"]) for row in pairs}) != 200:
        raise ValueError("Pairs must be unique")
    original = {row["id"]: {key: row[key] for key in ("id", "summary", "topics")} for row in source["profiles"]}
    if any(row != original[row["id"]] for row in profiles if row["id"] in original):
        raise ValueError("Original profile text must remain unchanged")
    if not set(original).issubset(profile_ids):
        raise ValueError("Original profiles must all be retained")
    for row in profiles:
        UUID(row["id"])
        if not row["summary"].strip() or not row["topics"]:
            raise ValueError("Profiles require a summary and topics")
    if Counter(row["profile_id"] for row in pairs) != Counter({identity: 2 for identity in profile_ids}):
        raise ValueError("Each profile must have exactly two pairs")
    if Counter(row["category"] for row in pairs) != CATEGORIES:
        raise ValueError("Seed judgment categories do not match the declared mix")
    for row in pairs:
        if row["profile_id"] not in profile_ids or row["video_id"] not in video_ids:
            raise ValueError("Pair references an unknown profile or video")
        category = row["category"]
        expected_close = category in {"close_call", "near_miss"}
        allowed_fit = {"yes", "unsure"} if category == "close_call" else {"yes" if category == "strong_match" else "no"}
        if row["predicted_fit"] not in allowed_fit or row["close_call"] is not expected_close:
            raise ValueError(f"Pair category, predicted fit, and close-call flag disagree: {row['profile_id']}:{row['video_id']}")
        if any(not 0 <= row[field] <= 1 for field in ("relevance_score", "difficulty_score")):
            raise ValueError("Pair scores must be finite values between zero and one")
        if not 6 <= len(row["decision_summary"].split()) <= 14 or len(row["decision_summary"]) > 160:
            raise ValueError(f"Decision summary requires 6-14 words and at most 160 characters: {row['profile_id']}:{row['video_id']}")
        if not 1 <= len(row["selection_rationale"].strip()) <= 500:
            raise ValueError("Selection rationales require 1-500 characters")
    return {
        "schema_version": 2,
        "extracted_at": source["extracted_at"],
        "profiles": profiles,
        "videos": videos,
        "pairs": pairs,
        "curation_method": "Assistant-curated from public titles and descriptions; awaiting independent human review.",
        "scoring_model": "GPT-6",
        "scoring_model_version": "assistant-curation-2026-09-04-v2",
    }


def build_migration(dataset: dict, source_commit: str, source_migrations: list[str]) -> str:
    if not source_commit.strip():
        raise ValueError("Source commit is required")
    digest = hashlib.sha256(canonical(dataset)).hexdigest()
    snapshot_id = str(uuid5(NAMESPACE_URL, f"finite-feed-match-lab-v2:{digest}"))
    payload = {
        **dataset,
        "snapshot_sha256": digest,
        "snapshot_id": snapshot_id,
        "source_commit": source_commit,
        "source_migrations": sorted(source_migrations),
    }
    encoded = canonical(payload).decode("utf-8")
    if "$dataset$" in encoded or "$seed$" in encoded:
        raise ValueError("Dataset contains a reserved SQL delimiter")
    return f"""-- Generated by backend.tools.build_match_lab_seed; do not edit applied migrations.
-- Assistant-curated sample, not adjudicated human gold. Source SHA256: {digest}
DO $seed$
DECLARE
    dataset JSONB := $dataset${encoded}$dataset$::jsonb;
    seed_snapshot UUID := (dataset->>'snapshot_id')::uuid;
BEGIN
    LOCK TABLE annotation_pair_scores, annotation_labels IN SHARE ROW EXCLUSIVE MODE;

    -- Fail on identity collisions rather than overwriting an existing source record.
    IF EXISTS (
        SELECT 1 FROM jsonb_to_recordset(dataset->'videos') AS item(id uuid, youtube_video_id text)
        JOIN videos existing ON existing.id = item.id OR existing.youtube_video_id = item.youtube_video_id
        WHERE existing.id <> item.id OR existing.youtube_video_id <> item.youtube_video_id
    ) THEN
        RAISE EXCEPTION 'Match Lab seed video identity conflicts with existing data';
    END IF;

    INSERT INTO videos (
        id, youtube_video_id, channel_name, title, youtube_url, thumbnail_url,
        description, published_at, duration_seconds, updated_at
    )
    SELECT id, youtube_video_id, channel_name, title,
           'https://www.youtube.com/watch?v=' || youtube_video_id,
           'https://i.ytimg.com/vi/' || youtube_video_id || '/hqdefault.jpg',
           description, published_at, duration_seconds, updated_at
    FROM jsonb_to_recordset(dataset->'videos') AS item(
        id uuid, youtube_video_id text, channel_name text, title text,
        description text, published_at timestamptz, duration_seconds integer, updated_at timestamptz
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO annotation_profiles (id, summary, topics, source)
    SELECT id, summary, topics, 'synthetic'
    FROM jsonb_to_recordset(dataset->'profiles') AS item(id uuid, summary text, topics text[])
    ON CONFLICT (id) DO NOTHING;

    -- Existing profile versions and video snapshots remain untouched.
    INSERT INTO annotation_videos (video_id, title, description, channel_name, source_updated_at)
    SELECT id, title, description, channel_name, updated_at
    FROM jsonb_to_recordset(dataset->'videos') AS item(
        id uuid, title text, description text, channel_name text, updated_at timestamptz
    )
    ON CONFLICT (video_id) DO NOTHING;

    INSERT INTO annotation_snapshots (
        id, snapshot_sha256, source_commit, source_migrations,
        profile_count, video_count, pair_count, provenance
    ) VALUES (
        seed_snapshot, dataset->>'snapshot_sha256', dataset->>'source_commit',
        ARRAY(SELECT jsonb_array_elements_text(dataset->'source_migrations')),
        100, 296, 29600,
        jsonb_build_object(
            'dataset', 'match-lab-v2', 'extracted_at', dataset->>'extracted_at',
            'curation_method', dataset->>'curation_method', 'selected_count', 200,
            'category_counts', '{{"strong_match":50,"close_call":60,"near_miss":40,"hard_negative":50}}'::jsonb,
            'hash_contract', 'SHA256 of canonical source and curation artifact, excluding migration provenance',
            'existing_snapshots', 'Preserved; source extraction is recorded in source-snapshot.json',
            'scores', 'Assistant judgment estimates, not calibrated probabilities'
        )
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO annotation_pair_scores (
        profile_id, video_id, relevance_score, difficulty_score, scoring_model,
        curated, predicted_fit, close_call, selection_rationale, decision_summary,
        scoring_model_version, snapshot_id, snapshot_provenance
    )
    SELECT item.profile_id, item.video_id, relevance_score, difficulty_score,
           dataset->>'scoring_model', TRUE, predicted_fit, close_call,
           selection_rationale, decision_summary, dataset->>'scoring_model_version', seed_snapshot,
           jsonb_build_object(
               'stable_id', item.profile_id::text || ':' || item.video_id::text,
               'category', category, 'topic_area', profile.topics[1],
               'snapshot_sha256', dataset->>'snapshot_sha256',
               'assessment_source', 'assistant', 'human_adjudicated', false
           )
    FROM jsonb_to_recordset(dataset->'pairs') AS item(
        profile_id uuid, video_id uuid, relevance_score double precision,
        difficulty_score double precision, predicted_fit text, close_call boolean,
        selection_rationale text, decision_summary text, category text
    )
    JOIN annotation_profiles profile ON profile.id = item.profile_id
    ON CONFLICT (profile_id, video_id) DO NOTHING;

    IF (SELECT count(*) FROM annotation_pair_scores WHERE snapshot_id = seed_snapshot) <> 200 THEN
        RAISE EXCEPTION 'Match Lab seed collides with existing pair assessments';
    END IF;

    -- Retain every existing reviewer judgment and close any already-reviewed seed pair.
    WITH counts AS (
        SELECT labels.profile_id, labels.video_id, labels.label, count(*) AS votes
        FROM annotation_labels labels
        JOIN annotation_pair_scores score USING (profile_id, video_id)
        WHERE score.snapshot_id = seed_snapshot
        GROUP BY labels.profile_id, labels.video_id, labels.label
    ), outcomes AS (
        SELECT profile_id, video_id, sum(votes) AS total,
               (array_agg(label ORDER BY votes DESC, label) FILTER (WHERE votes >= 2))[1] AS consensus
        FROM counts GROUP BY profile_id, video_id
    )
    UPDATE annotation_pair_scores score
    SET queue_status = CASE WHEN outcomes.consensus IS NOT NULL THEN 'consensus'
                            WHEN outcomes.total >= 3 THEN 'escalated' ELSE 'open' END,
        consensus_label = outcomes.consensus
    FROM outcomes
    WHERE score.profile_id = outcomes.profile_id AND score.video_id = outcomes.video_id
      AND score.snapshot_id = seed_snapshot;
END
$seed$;
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, default=MIGRATION)
    args = parser.parse_args()
    migrations = [path.name for path in (ROOT / "database" / "migrations").glob("*.sql") if path.name < MIGRATION.name]
    if "0011_match_lab_curated_queue.sql" not in migrations:
        raise RuntimeError("Merge the curated-queue migration before generating the seed")
    dataset = load_dataset()
    args.output.write_text(build_migration(dataset, args.source_commit, migrations), encoding="utf-8")
    print(json.dumps({"profiles": 100, "videos": 296, "pairs": 200, "sha256": hashlib.sha256(canonical(dataset)).hexdigest()}))


if __name__ == "__main__":
    main()
