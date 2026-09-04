from uuid import UUID

import pytest

from backend.app.settings import Settings
from backend.tools.match_lab import (
    curate_pairs,
    replace_dataset,
    replace_target_identity,
    validate_curated_artifact,
    validate_replace_scope,
)


def _snapshot(pair_count: int = 240) -> dict:
    pairs = []
    for index in range(pair_count):
        profile_id = UUID(int=(index % 30) + 1)
        video_id = UUID(int=(index % 80) + 1000)
        pairs.append(
            {
                "stable_id": f"{profile_id}:{video_id}",
                "profile": {"id": profile_id},
                "video": {"video_id": video_id},
            }
        )
    return {
        "schema_version": 1,
        "snapshot_id": "00000000-0000-0000-0000-000000000111",
        "snapshot_sha256": "a" * 64,
        "source_commit": "test",
        "source_migrations": ["0011_match_lab_curated_queue.sql"],
        "profile_count": 30,
        "video_count": 80,
        "pair_count": pair_count,
        "pairs": pairs,
    }


def _assessments(snapshot: dict) -> list[dict]:
    fits = ("yes", "unsure", "no", "no")
    return [
        {
            "stable_id": pair["stable_id"],
            "predicted_fit": fits[index % 4],
            "close_call": index % 4 in {1, 2},
            "selection_rationale": "Useful contrast for a balanced human evaluation set.",
            "decision_summary": "Topical evidence makes this a useful judgment boundary case.",
            "relevance_score": (index % 10) / 10,
            "difficulty_score": ((index + 3) % 10) / 10,
            "topic_area": f"topic-{index % 12}",
            "scoring_model": "test-model",
            "scoring_model_version": "2026-09-04",
        }
        for index, pair in enumerate(snapshot["pairs"])
    ]


def test_curation_is_reproducible_balanced_and_provenance_backed() -> None:
    snapshot = _snapshot()
    first = curate_pairs(snapshot, _assessments(snapshot))
    second = curate_pairs(snapshot, _assessments(snapshot))
    assert first == second
    assert len(first["pairs"]) == 200
    assert first["curation"]["profile_count"] == 30
    assert first["curation"]["video_count"] >= 60
    assert set(first["curation"]["category_counts"]) == {
        "strong_match", "close_call", "near_miss", "hard_negative"
    }
    assert all(pair["snapshot_provenance"]["snapshot_sha256"] == "a" * 64 for pair in first["pairs"])


def test_curation_rejects_missing_category_coverage() -> None:
    assessments = _assessments(_snapshot())
    for assessment in assessments:
        assessment["predicted_fit"] = "yes"
        assessment["close_call"] = False
    with pytest.raises(ValueError, match="assessed close_call"):
        curate_pairs(_snapshot(), assessments)


def test_invalid_artifact_is_rejected_before_database_lock_or_delete(tmp_path) -> None:
    class UntouchedConnection:
        def execute(self, *_args, **_kwargs):
            raise AssertionError("invalid artifact reached the database")

    invalid = {"schema_version": 1, "snapshot": {}, "curation": {"target_count": 200}, "pairs": []}
    with pytest.raises(ValueError, match="pair counts"):
        replace_dataset(UntouchedConnection(), invalid, backup_path=tmp_path / "backup.json", environment="test")


def test_artifact_validation_rejects_tampered_provenance() -> None:
    curated = curate_pairs(_snapshot(), _assessments(_snapshot()))
    curated["pairs"][0]["snapshot_provenance"]["snapshot_sha256"] = "b" * 64
    with pytest.raises(ValueError, match="provenance"):
        validate_curated_artifact(curated)


def test_replace_scope_requires_exact_environment_and_confirmation() -> None:
    settings = Settings(
        _env_file=None,
        PREVIEW_DATABASE_URL="postgresql://localhost/app",
        RAILWAY_ENVIRONMENT_NAME="pr-18",
        MATCH_LAB_TARGET_ENVIRONMENT="pr-18",
    )
    with pytest.raises(RuntimeError, match="Environment mismatch"):
        validate_replace_scope(settings, "production", "replace-match-lab:production:wrong", False)
    with pytest.raises(RuntimeError, match="Confirmation"):
        validate_replace_scope(settings, "pr-18", "wrong", False)
    fingerprint = replace_target_identity(settings)["fingerprint"]
    assert validate_replace_scope(settings, "pr-18", f"replace-match-lab:pr-18:{fingerprint}", False) == "pr-18"


def test_production_replace_requires_separate_opt_in() -> None:
    settings = Settings(
        _env_file=None,
        DATABASE_URL="postgresql://localhost/app",
        RAILWAY_ENVIRONMENT_NAME="production",
        MATCH_LAB_TARGET_ENVIRONMENT="production",
    )
    with pytest.raises(RuntimeError, match="--allow-production"):
        fingerprint = replace_target_identity(settings)["fingerprint"]
        validate_replace_scope(settings, "production", f"replace-match-lab:production:{fingerprint}", False)


def test_replace_requires_an_explicit_database_environment_marker() -> None:
    with pytest.raises(RuntimeError, match="MATCH_LAB_TARGET_ENVIRONMENT"):
        validate_replace_scope(
            Settings(_env_file=None, DATABASE_URL="postgresql://localhost/app"),
            "development",
            "replace-match-lab:development:wrong",
            False,
        )


def test_remote_database_requires_separate_opt_in_even_if_labeled_development() -> None:
    settings = Settings(
        _env_file=None,
        DATABASE_URL="postgresql://user:secret@production.example.com/app",
        RAILWAY_ENVIRONMENT_NAME="development",
        MATCH_LAB_TARGET_ENVIRONMENT="development",
    )
    with pytest.raises(RuntimeError, match="--allow-production"):
        fingerprint = replace_target_identity(settings)["fingerprint"]
        validate_replace_scope(settings, "development", f"replace-match-lab:development:{fingerprint}", False)


def test_remote_database_requires_authoritative_environment_identity() -> None:
    settings = Settings(
        _env_file=None,
        DATABASE_URL="postgresql://user:secret@production.example.com/app",
        MATCH_LAB_TARGET_ENVIRONMENT="development",
    )
    with pytest.raises(RuntimeError, match="RAILWAY_ENVIRONMENT_NAME"):
        validate_replace_scope(settings, "development", "replace-match-lab:development:wrong", True)
