import math

from backend.app.embeddings import cosine_similarity, embed_text


def test_embedding_is_stable_and_normalized() -> None:
    first = embed_text("psychology and football under pressure")
    second = embed_text("psychology and football under pressure")
    assert first == second
    assert math.isclose(sum(value * value for value in first), 1.0)


def test_related_text_scores_above_unrelated_text() -> None:
    profile = embed_text("psychology football coaching motivation")
    related = embed_text("football coaching and player psychology")
    unrelated = embed_text("ceramic glaze chemistry for pottery")
    assert cosine_similarity(profile, related) > cosine_similarity(profile, unrelated)
