from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from backend.app.settings import Settings, get_settings


REPLACE_LOCK_ID = 6_138_842_019
FIT_VALUES = {"yes", "no", "unsure"}
LOCAL_DATABASE_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _json_default(value: Any) -> str:
    if isinstance(value, (UUID, datetime, date)):
        return value.isoformat()
    raise TypeError(f"Cannot encode {type(value).__name__}")


def _canonical(value: Any) -> bytes:
    return json.dumps(value, default=_json_default, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _write_new_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        json.dump(payload, output, default=_json_default, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")


def build_snapshot(conn: psycopg.Connection, source_commit: str) -> dict[str, Any]:
    profiles = conn.execute(
        """
        SELECT id, summary, topics, source, version
        FROM annotation_profiles WHERE active ORDER BY id
        """
    ).fetchall()
    videos = conn.execute(
        """
        SELECT video_id, title, description, channel_name, source_updated_at
        FROM annotation_videos ORDER BY video_id
        """
    ).fetchall()
    migrations = [row["version"] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    pairs = [
        {
            "stable_id": f"{profile['id']}:{video['video_id']}",
            "profile": profile,
            "video": video,
        }
        for profile in profiles
        for video in videos
    ]
    digest = hashlib.sha256(_canonical(pairs)).hexdigest()
    return {
        "schema_version": 1,
        "snapshot_id": str(uuid5(NAMESPACE_URL, f"finite-feed-match-lab:{digest}")),
        "snapshot_sha256": digest,
        "source_commit": source_commit,
        "source_migrations": migrations,
        "profile_count": len(profiles),
        "video_count": len(videos),
        "pair_count": len(pairs),
        "pairs": pairs,
    }


def _category(item: dict[str, Any]) -> str:
    if item["close_call"]:
        return "close_call" if item["predicted_fit"] != "no" else "near_miss"
    if item["predicted_fit"] == "yes":
        return "strong_match"
    if item["predicted_fit"] == "no":
        return "hard_negative"
    return "near_miss"


def _validated_assessment(raw: dict[str, Any], snapshot_ids: set[str]) -> dict[str, Any]:
    required = {
        "stable_id",
        "predicted_fit",
        "close_call",
        "selection_rationale",
        "decision_summary",
        "relevance_score",
        "difficulty_score",
        "topic_area",
        "scoring_model",
        "scoring_model_version",
    }
    missing = required - raw.keys()
    if missing:
        raise ValueError(f"Assessment is missing {', '.join(sorted(missing))}")
    if raw["stable_id"] not in snapshot_ids:
        raise ValueError(f"Assessment references an unknown stable_id: {raw['stable_id']}")
    if raw["predicted_fit"] not in FIT_VALUES:
        raise ValueError("predicted_fit must be yes, no, or unsure")
    if not isinstance(raw["close_call"], bool):
        raise ValueError("close_call must be a boolean")
    for field in ("relevance_score", "difficulty_score"):
        if not 0 <= float(raw[field]) <= 1:
            raise ValueError(f"{field} must be between zero and one")
    summary_words = str(raw["decision_summary"]).split()
    if not 6 <= len(summary_words) <= 14:
        raise ValueError("decision_summary must be approximately ten words (6-14)")
    if not 1 <= len(str(raw["selection_rationale"]).strip()) <= 500:
        raise ValueError("selection_rationale must contain 1-500 characters")
    return {**raw, "category": _category(raw)}


def curate_pairs(
    snapshot: dict[str, Any],
    assessments: list[dict[str, Any]],
    *,
    target_count: int = 200,
    seed: str = "finite-feed-match-lab-v1",
) -> dict[str, Any]:
    if target_count < 1:
        raise ValueError("target_count must be positive")
    snapshot_pairs = {item["stable_id"]: item for item in snapshot["pairs"]}
    candidates = [_validated_assessment(item, set(snapshot_pairs)) for item in assessments]
    if len({item["stable_id"] for item in candidates}) != len(candidates):
        raise ValueError("Assessments must have unique stable_id values")
    if len(candidates) < target_count:
        raise ValueError(f"Need at least {target_count} assessed candidates; received {len(candidates)}")

    quotas = {
        "strong_match": round(target_count * 0.25),
        "close_call": round(target_count * 0.30),
        "near_miss": round(target_count * 0.20),
    }
    quotas["hard_negative"] = target_count - sum(quotas.values())
    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    profile_counts: Counter[str] = Counter()
    video_counts: Counter[str] = Counter()
    topic_counts: Counter[str] = Counter()

    def choose(pool: list[dict[str, Any]], wanted: int) -> None:
        for _ in range(wanted):
            eligible = [item for item in pool if item["stable_id"] not in selected_ids]
            if not eligible:
                return

            def balance_key(item: dict[str, Any]) -> tuple[int, int, int, str]:
                profile_id, video_id = item["stable_id"].split(":", 1)
                digest = hashlib.sha256(f"{seed}:{item['stable_id']}".encode()).hexdigest()
                return profile_counts[profile_id], video_counts[video_id], topic_counts[item["topic_area"]], digest

            choice = min(eligible, key=balance_key)
            selected.append(choice)
            selected_ids.add(choice["stable_id"])
            profile_id, video_id = choice["stable_id"].split(":", 1)
            profile_counts[profile_id] += 1
            video_counts[video_id] += 1
            topic_counts[choice["topic_area"]] += 1

    for category, quota in quotas.items():
        before = len(selected)
        choose([item for item in candidates if item["category"] == category], quota)
        if len(selected) - before != quota:
            raise ValueError(f"Need at least {quota} assessed {category} pairs")
    choose(candidates, target_count - len(selected))
    if len(selected) != target_count:
        raise ValueError(f"Could select only {len(selected)} of {target_count} requested pairs")

    output_pairs = []
    for assessment in selected:
        source_pair = snapshot_pairs[assessment["stable_id"]]
        output_pairs.append(
            {
                **{key: value for key, value in assessment.items() if key != "category"},
                "profile_id": str(source_pair["profile"]["id"]),
                "video_id": str(source_pair["video"]["video_id"]),
                "snapshot_provenance": {
                    "stable_id": assessment["stable_id"],
                    "topic_area": assessment["topic_area"],
                    "category": assessment["category"],
                    "snapshot_sha256": snapshot["snapshot_sha256"],
                },
            }
        )
    output_pairs.sort(key=lambda item: item["stable_id"])
    result = {
        "schema_version": 1,
        "snapshot": {key: value for key, value in snapshot.items() if key != "pairs"},
        "curation": {
            "target_count": target_count,
            "seed": seed,
            "selected_count": len(output_pairs),
            "category_counts": dict(Counter(_category(item) for item in output_pairs)),
            "profile_count": len(profile_counts),
            "video_count": len(video_counts),
            "topic_area_count": len(topic_counts),
        },
        "pairs": output_pairs,
    }
    validate_curated_artifact(result)
    return result


def validate_curated_artifact(curated: dict[str, Any]) -> None:
    snapshot = curated.get("snapshot")
    curation = curated.get("curation")
    pairs = curated.get("pairs")
    if curated.get("schema_version") != 1 or not isinstance(snapshot, dict) or not isinstance(curation, dict):
        raise ValueError("Curated artifact metadata is invalid")
    if not isinstance(pairs, list):
        raise ValueError("Curated artifact pairs must be a list")
    target_count = curation.get("target_count")
    if not isinstance(target_count, int) or not 150 <= target_count <= 250:
        raise ValueError("Curated artifact target_count must be approximately 200 (150-250)")
    if len(pairs) != target_count or curation.get("selected_count") != len(pairs):
        raise ValueError("Curated artifact pair counts do not match")
    snapshot_id = str(snapshot.get("snapshot_id", ""))
    snapshot_sha = str(snapshot.get("snapshot_sha256", ""))
    try:
        UUID(snapshot_id)
    except ValueError as exc:
        raise ValueError("Curated artifact snapshot_id is invalid") from exc
    if len(snapshot_sha) != 64 or any(character not in "0123456789abcdef" for character in snapshot_sha):
        raise ValueError("Curated artifact snapshot checksum is invalid")

    stable_ids: set[str] = set()
    categories: Counter[str] = Counter()
    profiles: set[str] = set()
    videos: set[str] = set()
    topics: set[str] = set()
    required_text = ("selection_rationale", "decision_summary", "scoring_model", "scoring_model_version")
    for pair in pairs:
        profile_id = str(pair.get("profile_id", ""))
        video_id = str(pair.get("video_id", ""))
        stable_id = str(pair.get("stable_id", ""))
        try:
            UUID(profile_id)
            UUID(video_id)
        except ValueError as exc:
            raise ValueError("Curated pair IDs must be UUIDs") from exc
        if stable_id != f"{profile_id}:{video_id}" or stable_id in stable_ids:
            raise ValueError("Curated pair stable IDs must be unique and match profile/video IDs")
        if pair.get("predicted_fit") not in FIT_VALUES or not isinstance(pair.get("close_call"), bool):
            raise ValueError("Curated pair assessment metadata is invalid")
        for field in ("relevance_score", "difficulty_score"):
            try:
                score = float(pair.get(field))
            except (TypeError, ValueError) as exc:
                raise ValueError("Curated pair scores must be numeric") from exc
            if not 0 <= score <= 1:
                raise ValueError("Curated pair scores must be between zero and one")
        if any(not str(pair.get(field, "")).strip() for field in required_text):
            raise ValueError("Curated pair assessment text is incomplete")
        provenance = pair.get("snapshot_provenance")
        if (
            not isinstance(provenance, dict)
            or provenance.get("snapshot_sha256") != snapshot_sha
            or provenance.get("stable_id") != stable_id
        ):
            raise ValueError("Curated pair snapshot provenance is invalid")
        category = provenance.get("category")
        topic = str(provenance.get("topic_area", "")).strip()
        if category not in {"strong_match", "close_call", "near_miss", "hard_negative"} or not topic:
            raise ValueError("Curated pair coverage metadata is invalid")
        stable_ids.add(stable_id)
        categories[category] += 1
        profiles.add(profile_id)
        videos.add(video_id)
        topics.add(topic)

    if set(categories) != {"strong_match", "close_call", "near_miss", "hard_negative"}:
        raise ValueError("Curated artifact must include all four judgment categories")
    if curation.get("category_counts") != dict(categories):
        raise ValueError("Curated artifact category counts do not match its pairs")
    minimum_profiles = min(int(snapshot.get("profile_count", 0)), max(1, round(target_count * 0.10)))
    minimum_videos = min(int(snapshot.get("video_count", 0)), max(1, round(target_count * 0.25)))
    if len(profiles) < minimum_profiles or len(videos) < minimum_videos or len(topics) < 4:
        raise ValueError("Curated artifact does not meet profile, video, and topic coverage minimums")


def replace_target_identity(settings: Settings) -> dict[str, str | bool]:
    parsed = urlsplit(settings.effective_database_url)
    host = (parsed.hostname or "").lower()
    database = parsed.path.lstrip("/")
    if not host or not database:
        raise RuntimeError("DATABASE_URL must identify a database host and name")
    fingerprint = hashlib.sha256(f"{host}/{database}".encode()).hexdigest()[:12]
    return {
        "host": host,
        "database": database,
        "fingerprint": fingerprint,
        "remote": host not in LOCAL_DATABASE_HOSTS,
    }


def validate_replace_scope(settings: Settings, environment: str, confirmation: str, allow_production: bool) -> str:
    actual = (settings.match_lab_target_environment or "").strip()
    if not actual:
        raise RuntimeError("MATCH_LAB_TARGET_ENVIRONMENT must explicitly identify the target database")
    target = replace_target_identity(settings)
    if target["remote"] and not settings.railway_environment_name:
        raise RuntimeError("Remote replacement requires an authoritative RAILWAY_ENVIRONMENT_NAME")
    if settings.railway_environment_name and actual != settings.railway_environment_name:
        raise RuntimeError(
            "MATCH_LAB_TARGET_ENVIRONMENT does not match RAILWAY_ENVIRONMENT_NAME; refusing replacement"
        )
    if environment != actual:
        raise RuntimeError(f"Environment mismatch: requested {environment!r}, configured {actual!r}")
    expected_confirmation = f"replace-match-lab:{actual}:{target['fingerprint']}"
    if confirmation != expected_confirmation:
        raise RuntimeError(f"Confirmation must exactly equal {expected_confirmation}")
    if (actual.lower() in {"prod", "production"} or target["remote"]) and not allow_production:
        raise RuntimeError("Production or remote database replacement also requires --allow-production")
    return actual


def replace_dataset(
    conn: psycopg.Connection,
    curated: dict[str, Any],
    *,
    backup_path: Path,
    environment: str,
) -> dict[str, int | str]:
    validate_curated_artifact(curated)
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (REPLACE_LOCK_ID,))
    conn.execute("LOCK TABLE annotation_pair_scores, annotation_labels IN ACCESS EXCLUSIVE MODE")
    backup = {
        "schema_version": 1,
        "environment": environment,
        "exported_at": datetime.now().astimezone(),
        "annotation_labels": conn.execute("SELECT * FROM annotation_labels ORDER BY created_at, id").fetchall(),
        "annotation_pair_scores": conn.execute(
            "SELECT * FROM annotation_pair_scores ORDER BY profile_id, video_id"
        ).fetchall(),
        "annotation_snapshots": conn.execute("SELECT * FROM annotation_snapshots ORDER BY created_at, id").fetchall(),
    }
    _write_new_json(backup_path, backup)
    deleted_labels = conn.execute("DELETE FROM annotation_labels RETURNING id").fetchall()
    deleted_pairs = conn.execute("DELETE FROM annotation_pair_scores RETURNING profile_id").fetchall()

    snapshot = curated["snapshot"]
    conn.execute(
        """
        INSERT INTO annotation_snapshots (
            id, snapshot_sha256, source_commit, source_migrations,
            profile_count, video_count, pair_count, provenance
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO NOTHING
        """,
        (
            snapshot["snapshot_id"], snapshot["snapshot_sha256"], snapshot["source_commit"],
            snapshot["source_migrations"], snapshot["profile_count"], snapshot["video_count"],
            snapshot["pair_count"], Jsonb({"curation": curated["curation"]}),
        ),
    )
    for pair in curated["pairs"]:
        conn.execute(
            """
            INSERT INTO annotation_pair_scores (
                profile_id, video_id, relevance_score, difficulty_score, scoring_model,
                curated, predicted_fit, close_call, selection_rationale, decision_summary,
                scoring_model_version, snapshot_id, snapshot_provenance
            ) VALUES (%s, %s, %s, %s, %s, TRUE, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                pair["profile_id"], pair["video_id"], pair["relevance_score"],
                pair["difficulty_score"], pair["scoring_model"], pair["predicted_fit"],
                pair["close_call"], pair["selection_rationale"], pair["decision_summary"],
                pair["scoring_model_version"], snapshot["snapshot_id"], Jsonb(pair["snapshot_provenance"]),
            ),
        )
    conn.commit()
    return {
        "environment": environment,
        "exported_labels": len(backup["annotation_labels"]),
        "exported_pairs": len(backup["annotation_pair_scores"]),
        "deleted_labels": len(deleted_labels),
        "deleted_pairs": len(deleted_pairs),
        "loaded_pairs": len(curated["pairs"]),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reproducible Match Lab dataset operations")
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot = subparsers.add_parser("snapshot", help="Export the full current profile-video cross-product")
    snapshot.add_argument("--output", type=Path, required=True)
    snapshot.add_argument("--source-commit", default=os.environ.get("APP_COMMIT_SHA", "local"))
    curate = subparsers.add_parser("curate", help="Balance AI assessments into the curated queue dataset")
    curate.add_argument("--snapshot", type=Path, required=True)
    curate.add_argument("--assessments", type=Path, required=True)
    curate.add_argument("--output", type=Path, required=True)
    curate.add_argument("--target-count", type=int, default=200)
    curate.add_argument("--seed", default="finite-feed-match-lab-v1")
    subparsers.add_parser("target", help="Inspect the non-secret replacement target identity")
    replace = subparsers.add_parser("replace", help="Export, clear, and transactionally load the curated queue")
    replace.add_argument("--curated", type=Path, required=True)
    replace.add_argument("--backup", type=Path, required=True)
    replace.add_argument("--environment", required=True)
    replace.add_argument("--confirm", required=True)
    replace.add_argument("--allow-production", action="store_true")
    return parser


def main() -> None:
    args = _parser().parse_args()
    settings = get_settings()
    if args.command == "curate":
        snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
        assessment_payload = json.loads(args.assessments.read_text(encoding="utf-8"))
        assessments = assessment_payload.get("assessments", assessment_payload) if isinstance(assessment_payload, dict) else assessment_payload
        _write_new_json(
            args.output,
            curate_pairs(snapshot, assessments, target_count=args.target_count, seed=args.seed),
        )
        print(json.dumps({"selected": args.target_count, "output": str(args.output)}))
        return
    if args.command == "target":
        environment = (settings.match_lab_target_environment or "").strip()
        if not environment:
            raise RuntimeError("MATCH_LAB_TARGET_ENVIRONMENT must explicitly identify the target database")
        target = replace_target_identity(settings)
        print(json.dumps({
            **target,
            "environment": environment,
            "confirmation": f"replace-match-lab:{environment}:{target['fingerprint']}",
        }))
        return
    with psycopg.connect(settings.effective_database_url, row_factory=dict_row) as conn:
        if args.command == "snapshot":
            payload = build_snapshot(conn, args.source_commit)
            _write_new_json(args.output, payload)
            print(json.dumps({key: payload[key] for key in ("snapshot_id", "snapshot_sha256", "pair_count")}))
            return
        environment = validate_replace_scope(settings, args.environment, args.confirm, args.allow_production)
        curated = json.loads(args.curated.read_text(encoding="utf-8"))
        print(json.dumps(replace_dataset(conn, curated, backup_path=args.backup, environment=environment)))


if __name__ == "__main__":
    main()
