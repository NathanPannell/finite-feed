import hashlib
import math
import re

TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
DIMENSIONS = 256
MODEL_NAME = "local-feature-hash-v1"


def embed_text(text: str) -> list[float]:
    """Create a stable, normalized vector without an external embedding bill."""
    tokens = TOKEN_PATTERN.findall(text.lower())
    features = tokens + [f"{left}_{right}" for left, right in zip(tokens, tokens[1:])]
    vector = [0.0] * DIMENSIONS
    for feature in features:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % DIMENSIONS
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[bucket] += sign
    magnitude = math.sqrt(sum(value * value for value in vector))
    return [value / magnitude for value in vector] if magnitude else vector


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    return sum(a * b for a, b in zip(left, right))
