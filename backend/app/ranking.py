import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from backend.app.description_processing import clean_description

TOKEN_PATTERN = re.compile(r"[a-z0-9]{3,}")


@dataclass(frozen=True)
class Candidate:
    id: str
    title: str
    description: str
    view_count: int
    channel_baseline_views: int
    published_at: datetime


def rank_candidate(candidate: Candidate, preference_statement: str, now: datetime | None = None) -> tuple[float, dict[str, float]]:
    current_time = now or datetime.now(UTC)
    age_days = max((current_time - candidate.published_at).total_seconds() / 86400, 1)
    preference_tokens = set(TOKEN_PATTERN.findall(preference_statement.lower()))
    candidate_tokens = set(
        TOKEN_PATTERN.findall(f"{candidate.title} {clean_description(candidate.description)}".lower())
    )
    relevance = len(preference_tokens & candidate_tokens) / max(len(preference_tokens), 1)
    relative_views = candidate.view_count / max(candidate.channel_baseline_views, 1)
    momentum = math.log1p(relative_views) / math.sqrt(age_days)
    score = relevance * 0.72 + min(momentum, 1.0) * 0.28
    return score, {"semantic_keyword_overlap": round(relevance, 4), "age_normalized_momentum": round(momentum, 4)}
