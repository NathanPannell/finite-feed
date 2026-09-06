import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path

from backend.app.embeddings import Embedder, configured_embedder
from backend.app.openrouter import OpenRouterClient
from backend.app.settings import Settings

CASES_PATH = Path(__file__).with_name("cases.json")
TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


def retrieval_winner(case: dict, embedder: Embedder) -> str:
    profile = embedder.embed_queries([case["profile"]])[0]
    documents = embedder.embed_documents([
        f"{candidate['title']}\n{candidate['description']}" for candidate in case["candidates"]
    ])
    scores = [sum(left * right for left, right in zip(profile, document)) for document in documents]
    return case["candidates"][max(range(len(scores)), key=scores.__getitem__)]["video_id"]


def _legacy_feature_hash(text: str) -> list[float]:
    tokens = TOKEN_PATTERN.findall(text.lower())
    features = tokens + [f"{left}_{right}" for left, right in zip(tokens, tokens[1:])]
    vector = [0.0] * 256
    for feature in features:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % len(vector)
        vector[bucket] += 1.0 if digest[4] & 1 else -1.0
    magnitude = math.sqrt(sum(value * value for value in vector))
    return [value / magnitude for value in vector] if magnitude else vector


def legacy_winner(case: dict) -> str:
    profile = _legacy_feature_hash(case["profile"])
    scores = []
    for candidate in case["candidates"]:
        document = _legacy_feature_hash(f"{candidate['title']}\n{candidate['description']}")
        scores.append(sum(left * right for left, right in zip(profile, document)))
    return case["candidates"][max(range(len(scores)), key=scores.__getitem__)]["video_id"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Finite Feed's small, genre-specific recommendation eval.")
    parser.add_argument("--with-model", action="store_true", help="Also test the configured OpenRouter model.")
    args = parser.parse_args()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    embedder = configured_embedder(Settings())
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if args.with_model and not key:
        raise SystemExit("OPENROUTER_API_KEY is required with --with-model")
    client = OpenRouterClient(
        key,
        os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free"),
        os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        os.environ.get("PUBLIC_APP_URL", "http://localhost:8000"),
    ) if args.with_model else None
    results = []
    try:
        for case in cases:
            retrieved = retrieval_winner(case, embedder)
            legacy = legacy_winner(case)
            model_choice = client.choose(case["profile"], case["candidates"]).video_id if client else None
            results.append({
                "case": case["name"],
                "expected": case["expected_video_id"],
                "retrieved": retrieved,
                "retrieval_pass": retrieved == case["expected_video_id"],
                "legacy_retrieved": legacy,
                "legacy_expected_failure_pass": (
                    legacy != case["expected_video_id"]
                    if case.get("legacy_feature_hash_expected_to_fail") else None
                ),
                "model_choice": model_choice,
                "model_pass": model_choice == case["expected_video_id"] if client else None,
            })
    finally:
        if client:
            client.close()
    print(json.dumps(results, indent=2))
    passed = all(result["retrieval_pass"] for result in results)
    passed = passed and all(
        result["legacy_expected_failure_pass"] is not False for result in results
    )
    passed = passed and all(result["model_pass"] is not False for result in results)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
