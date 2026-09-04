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


def test_promotional_description_terms_do_not_influence_keyword_scoring() -> None:
    now = datetime(2026, 9, 2, tzinfo=UTC)
    candidate = Candidate(
        "promo",
        "A history of stage lighting",
        "A theatrical design story.\nSubscribe for production AI agent evaluation videos.",
        100,
        100,
        now - timedelta(days=2),
    )

    _, evidence = rank_candidate(candidate, "production AI agent evaluation", now)

    assert evidence["semantic_keyword_overlap"] == 0
