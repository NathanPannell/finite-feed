import math

from backend.app.embeddings import DEFAULT_DIMENSIONS, SemanticEmbedder, get_embedder


class FakeModel:
    def __init__(self) -> None:
        self.calls = []

    def get_embedding_dimension(self) -> int:
        return DEFAULT_DIMENSIONS

    def encode(self, texts, **kwargs):
        self.calls.append((texts, kwargs))
        vector = [1.0 / math.sqrt(DEFAULT_DIMENSIONS)] * DEFAULT_DIMENSIONS

        class Array:
            def tolist(self):
                return [vector for _ in texts]

        return Array()


def test_query_prompt_is_applied_only_to_queries(monkeypatch) -> None:
    model = FakeModel()
    embedder = SemanticEmbedder()
    monkeypatch.setattr(embedder, "_load_model", lambda: model)

    documents = embedder.embed_documents(["A resilient group recovered after a defeat."])
    queries = embedder.embed_queries(["How do teams bounce back from setbacks?"])

    assert "prompt_name" not in model.calls[0][1]
    assert model.calls[1][1]["prompt_name"] == "query"
    assert model.calls[0][1]["normalize_embeddings"] is True
    assert len(documents[0]) == len(queries[0]) == DEFAULT_DIMENSIONS


def test_embedder_is_cached_once_per_exact_configuration() -> None:
    get_embedder.cache_clear()
    first = get_embedder()
    second = get_embedder()
    assert first is second


def test_database_dimension_is_enforced() -> None:
    try:
        SemanticEmbedder(dimensions=256)
    except ValueError as exc:
        assert "384-dimensional" in str(exc)
    else:
        raise AssertionError("Expected an invalid database dimension to be rejected")
