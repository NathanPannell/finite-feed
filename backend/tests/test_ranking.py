from datetime import UTC, datetime, timedelta

from backend.app.ranking import Candidate, rank_candidate


def test_relevance_can_outweigh_raw_views() -> None:
    now = datetime(2026, 9, 2, tzinfo=UTC)
    relevant = Candidate(
        "a", "Reliable evaluated AI agents", "Practical production systems",
        1000, 1000, now - timedelta(days=3),
    )
    viral = Candidate(
        "b", "A history of stage lighting", "Theater design",
        1_000_000, 10_000, now - timedelta(days=30),
    )
    relevant_score, evidence = rank_candidate(
        relevant, "production AI agents with evaluation", now
    )
    viral_score, _ = rank_candidate(
        viral, "production AI agents with evaluation", now
    )
    assert relevant_score > viral_score
    assert evidence["semantic_keyword_overlap"] > 0
