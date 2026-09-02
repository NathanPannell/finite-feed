import json
import re
from dataclasses import dataclass

import httpx

JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


@dataclass(frozen=True)
class ModelChoice:
    video_id: str
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
            "Choose exactly one YouTube talk for this user. Prefer a precise, surprising fit over broad popularity. "
            "Use only the supplied evidence. Return JSON with video_id and a concise two-sentence rationale.\n\n"
            f"USER PROFILE:\n{preference}\n\nCANDIDATES:\n{json.dumps(candidates, default=str)}"
        )
        response = self.client.post("/chat/completions", json={
            "model": self.model,
            "messages": [
                {"role": "system", "content": "You are a careful recommendation judge. Output JSON only."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        })
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        match = JSON_BLOCK.search(content)
        if not match:
            raise ValueError("OpenRouter response did not contain a JSON object")
        parsed = json.loads(match.group(0))
        allowed_ids = {candidate["video_id"] for candidate in candidates}
        if parsed.get("video_id") not in allowed_ids:
            raise ValueError("OpenRouter selected a video outside the supplied shortlist")
        rationale = str(parsed.get("rationale", "")).strip()
        if not rationale:
            raise ValueError("OpenRouter response omitted its rationale")
        return ModelChoice(parsed["video_id"], rationale, payload.get("model", self.model))

    def close(self) -> None:
        self.client.close()
