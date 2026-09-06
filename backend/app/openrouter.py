import json
import re
from dataclasses import dataclass

import httpx

FREE_PRIMARY_MODEL = "google/gemma-4-31b-it:free"
FREE_FALLBACK_MODEL = "google/gemma-4-26b-a4b-it:free"

JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


@dataclass(frozen=True)
class ModelChoice:
    video_id: str | None
    rationale: str
    model: str


class OpenRouterClient:
    def __init__(self, api_key: str, model: str, base_url: str, app_url: str):
        self.model = model
        self.client = httpx.Client(
            base_url=base_url,
            timeout=45.0,
            headers={
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": app_url,
                "X-Title": "Finite Feed",
            },
        )

    def choose(self, preference: str, candidates: list[dict]) -> ModelChoice:
        prompt = (
            "Choose at most one YouTube talk for this user. Explicit exclusions are mandatory. Return video_id: null if no candidate is a strong fit. Prefer a precise, surprising fit over broad popularity. "
            "Use only the supplied evidence. Return JSON with video_id and a concise two-sentence rationale.\n\n"
            f"USER PROFILE:\n{preference}\n\nCANDIDATES:\n{json.dumps(candidates, default=str)}"
        )
        # OpenRouter performs ordered failover inside one HTTP request, including
        # provider rate limits. Both explicit routes are free; custom pins stay exact.
        # https://openrouter.ai/docs/guides/routing/model-fallbacks
        routing = {"models": [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL]} if self.model == FREE_PRIMARY_MODEL else {"model": self.model}
        response = self.client.post("/chat/completions", json={
            **routing,
            "messages": [
                {"role": "system", "content": "You are a careful recommendation judge. Output JSON only."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": 350,
        })
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        match = JSON_BLOCK.search(content)
        if not match:
            raise ValueError("OpenRouter response did not contain a JSON object")
        parsed = json.loads(match.group(0))
        allowed_ids = {candidate["video_id"] for candidate in candidates}
        if parsed.get("video_id") is not None and parsed.get("video_id") not in allowed_ids:
            raise ValueError("OpenRouter selected a video outside the supplied shortlist")
        rationale = str(parsed.get("rationale", "")).strip()
        if not rationale:
            raise ValueError("OpenRouter response omitted its rationale")
        resolved_model = payload.get("model")
        if "models" in routing and (not isinstance(resolved_model, str) or not resolved_model.strip()):
            raise ValueError("OpenRouter response omitted the model used for its selection")
        return ModelChoice(parsed.get("video_id"), rationale, resolved_model or self.model)

    def close(self) -> None:
        self.client.close()
