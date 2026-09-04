import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Protocol, Sequence

DEFAULT_MODEL_NAME = "Snowflake/snowflake-arctic-embed-xs"
DEFAULT_MODEL_REVISION = "d8c86521100d3556476a063fc2342036d45c106f"
DEFAULT_DIMENSIONS = 384


class Embedder(Protocol):
    model_name: str
    model_revision: str
    dimensions: int

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]: ...


class SemanticEmbedder:
    """Pinned, process-local Arctic Embed encoder with asymmetric query prompts."""

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL_NAME,
        revision: str = DEFAULT_MODEL_REVISION,
        dimensions: int = DEFAULT_DIMENSIONS,
        batch_size: int = 32,
        cache_dir: str | None = None,
        offline: bool = False,
    ) -> None:
        if dimensions != DEFAULT_DIMENSIONS:
            raise ValueError(f"The current database schema requires {DEFAULT_DIMENSIONS}-dimensional embeddings")
        self.model_name = model_name
        self.model_revision = revision
        self.dimensions = dimensions
        self.batch_size = batch_size
        self.cache_dir = cache_dir
        self.offline = offline
        self._model = None
        self._load_lock = threading.Lock()

    def _load_model(self):
        if self._model is None:
            with self._load_lock:
                if self._model is None:
                    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
                    from sentence_transformers import SentenceTransformer

                    model = SentenceTransformer(
                        self.model_name,
                        revision=self.model_revision,
                        cache_folder=self.cache_dir,
                        local_files_only=self.offline,
                    )
                    actual_dimensions = model.get_embedding_dimension()
                    if actual_dimensions != self.dimensions:
                        raise RuntimeError(
                            f"Embedding model produced {actual_dimensions} dimensions; expected {self.dimensions}"
                        )
                    self._model = model
        return self._model

    def _encode(self, texts: Sequence[str], *, query: bool) -> list[list[float]]:
        if not texts:
            return []
        kwargs = {
            "batch_size": self.batch_size,
            "normalize_embeddings": True,
            "convert_to_numpy": True,
            "show_progress_bar": False,
        }
        if query:
            kwargs["prompt_name"] = "query"
        vectors = self._load_model().encode(list(texts), **kwargs)
        result = vectors.tolist()
        if any(len(vector) != self.dimensions for vector in result):
            raise RuntimeError("Embedding model returned an unexpected vector dimension")
        return result

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return self._encode(texts, query=False)

    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return self._encode(texts, query=True)


@lru_cache(maxsize=8)
def get_embedder(
    model_name: str = DEFAULT_MODEL_NAME,
    revision: str = DEFAULT_MODEL_REVISION,
    dimensions: int = DEFAULT_DIMENSIONS,
    batch_size: int = 32,
    cache_dir: str | None = None,
    offline: bool = False,
) -> SemanticEmbedder:
    """Return one lazily loaded model per process and exact configuration."""
    return SemanticEmbedder(model_name, revision, dimensions, batch_size, cache_dir, offline)


def configured_embedder(settings) -> SemanticEmbedder:
    return get_embedder(
        settings.embedding_model,
        settings.embedding_model_revision,
        settings.embedding_dimensions,
        settings.embedding_batch_size,
        settings.embedding_cache_dir,
        settings.embedding_offline,
    )


def cache_default_model(cache_dir: str | None = None) -> Path | None:
    """Download and validate the pinned model for deterministic image builds."""
    embedder = get_embedder(cache_dir=cache_dir, offline=False)
    embedder.embed_documents(["Finite Feed model cache warmup."])
    return Path(cache_dir) if cache_dir else None


if __name__ == "__main__":
    cache_default_model(os.environ.get("HF_HOME"))
