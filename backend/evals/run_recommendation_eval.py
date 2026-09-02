import argparse
import json
import os
from pathlib import Path

from backend.app.embeddings import cosine_similarity, embed_text
from backend.app.openrouter import OpenRouterClient

CASES_PATH = Path(__file__).with_name("cases.json")


def retrieval_winner(case: dict) -> str:
    profile = embed_text(case["profile"])
    return max(
        case["candidates"],
        key=lambda candidate: cosine_similarity(profile, embed_text(f"{candidate['title']}\n{candidate['description']}")),
    )["video_id"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Finite Feed's small, genre-specific recommendation eval.")
    parser.add_argument("--with-model", action="store_true", help="Also test the configured OpenRouter model.")
    args = parser.parse_args()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if args.with_model and not key:
        raise SystemExit("OPENROUTER_API_KEY is required with --with-model")
    client = OpenRouterClient(
        key,
        os.environ.get("OPENROUTER_MODEL", "openrouter/free"),
        os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        os.environ.get("PUBLIC_APP_URL", "http://localhost:8000"),
    ) if args.with_model else None
    results = []
    try:
        for case in cases:
            retrieved = retrieval_winner(case)
            model_choice = client.choose(case["profile"], case["candidates"]).video_id if client else None
            results.append({
                "case": case["name"],
                "expected": case["expected_video_id"],
                "retrieved": retrieved,
                "retrieval_pass": retrieved == case["expected_video_id"],
                "model_choice": model_choice,
                "model_pass": model_choice == case["expected_video_id"] if client else None,
            })
    finally:
        if client:
            client.close()
    print(json.dumps(results, indent=2))
    return 0 if all(result["retrieval_pass"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
