import json
import re
from dataclasses import dataclass

import httpx

FREE_PRIMARY_MODEL = "google/gemma-4-31b-it:free"
FREE_FALLBACK_MODEL = "google/gemma-4-26b-a4b-it:free"
FREE_ALTERNATE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


@dataclass(frozen=True)
class ModelChoice:
    video_id: str | None
    rationale: str
    model: str


@dataclass(frozen=True)
class PreferenceSynthesis:
    profile: str
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
            "Use only the supplied evidence. Return JSON with video_id and a casual, concise one-sentence rationale.\n\n"
            f"USER PROFILE:\n{preference}\n\nCANDIDATES:\n{json.dumps(candidates, default=str)}"
        )
        # OpenRouter performs ordered failover inside one HTTP request, including
        # provider rate limits. Every explicit route is free; custom pins stay exact.
        # https://openrouter.ai/docs/guides/routing/model-fallbacks
        routing = {
            "models": [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL, FREE_ALTERNATE_MODEL],
            # Optional thinking must not consume the small JSON response budget.
            "reasoning": {"enabled": False},
        } if self.model == FREE_PRIMARY_MODEL else {"model": self.model}
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
        # Retain one complete sentence if a provider ignores the requested shape.
        rationale = re.split(r"(?<=[.!?])\s+", rationale, maxsplit=1)[0]
        if rationale[-1] not in ".!?":
            rationale += "."
        resolved_model = payload.get("model")
        if "models" in routing and (not isinstance(resolved_model, str) or not resolved_model.strip()):
            raise ValueError("OpenRouter response omitted the model used for its selection")
        return ModelChoice(parsed.get("video_id"), rationale, resolved_model or self.model)

    def synthesize_preferences(self, answers: dict, open_response: str, questions: tuple[dict, ...]) -> PreferenceSynthesis:
        labels = {
            str(question["id"]): next(
                option["label"] for option in question["options"]
                if option["value"] == answers[str(question["id"])]
            )
            for question in questions
        }
        prompt = (
            "Combine the structured choices and the user's own words into one preference profile. "
            "Write 2 to 5 concrete sentences in first person. Preserve specific interests, desired outcomes, "
            "style preferences, and explicit exclusions. Do not invent facts or add a heading. "
            "Return JSON with one string field named profile.\n\n"
            f"CHOICES:\n{json.dumps(labels)}\n\nUSER WORDS:\n{open_response}"
        )
        routing = {
            "models": [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL, FREE_ALTERNATE_MODEL],
            "reasoning": {"enabled": False},
        } if self.model == FREE_PRIMARY_MODEL else {"model": self.model}
        response = self.client.post("/chat/completions", json={
            **routing,
            "messages": [
                {"role": "system", "content": "You build faithful preference profiles. Output JSON only."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": 350,
        })
        response.raise_for_status()
        payload = response.json()
        match = JSON_BLOCK.search(payload["choices"][0]["message"]["content"])
        if not match:
            raise ValueError("OpenRouter response did not contain a JSON object")
        profile = str(json.loads(match.group(0)).get("profile", "")).strip()
        sentences = re.findall(r"[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$", profile)
        if not profile or not 2 <= len(sentences) <= 5 or len(profile) > 5000:
            raise ValueError("OpenRouter response must contain a 2 to 5 sentence profile")
        resolved_model = payload.get("model")
        if "models" in routing and (not isinstance(resolved_model, str) or not resolved_model.strip()):
            raise ValueError("OpenRouter response omitted the model used for synthesis")
        return PreferenceSynthesis(profile, resolved_model or self.model)

    def close(self) -> None:
        self.client.close()


def provider_failure(exc: Exception) -> tuple[str, str]:
    """Classify provider diagnostics without returning any provider-supplied text."""
    unavailable = "The recommendation provider is unavailable. Please try again later."
    if not isinstance(exc, httpx.HTTPStatusError):
        code = "provider_timeout" if isinstance(exc, httpx.TimeoutException) else "provider_unavailable"
        return code, unavailable
    status = exc.response.status_code
    code = f"provider_http_{status}"
    if status == 402:
        return code, "The recommendation service has reached its provider limit. Please try again later."
    if status != 429:
        return code, unavailable
    try:
        payload = exc.response.json()
    except (ValueError, UnicodeDecodeError):
        payload = {}
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    error = error if isinstance(error, dict) else {}
    message = error.get("message", "")
    message = message.lower() if isinstance(message, str) else ""
    if re.search(r"\bdaily\b|\bday\b", message):
        return "provider_daily_limit", "The recommendation provider's daily free allowance is exhausted. Please try again after its daily reset."
    if re.search(r"\bminute\b|\bperminute\b", message):
        return "provider_minute_limit", "The recommendation provider is receiving requests too quickly. Please wait a minute before trying again."
    metadata = error.get("metadata", {})
    metadata = metadata if isinstance(metadata, dict) else {}
    raw = metadata.get("raw", "")
    if isinstance(raw, dict):
        raw = json.dumps(raw)
    raw = raw.lower() if isinstance(raw, str) else ""
    upstream_message = "upstream" in message and ("rate" in message or "temporar" in message)
    upstream_metadata = bool(metadata.get("provider_name")) and any(word in raw for word in ("rate", "temporar", "quota", "exhaust"))
    if upstream_message or upstream_metadata:
        return "provider_upstream_limit", "The free recommendation models are temporarily busy. Your preferences are saved; please try again later."
    return code, "The recommendation service has reached a provider limit. Please try again later."
