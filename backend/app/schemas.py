from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator


class ProfileUpdate(BaseModel):
    preference_statement: str = Field(min_length=1, max_length=5000)
    timezone: str = Field(default="America/Los_Angeles", min_length=1, max_length=80)
    cadence_days: list[int] = Field(default=[1, 4], min_length=1, max_length=7)
    delivery_hour: int = Field(default=9, ge=0, le=23)
    recommendation_count: int = Field(default=1, ge=1, le=10)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value.strip())
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Use a valid IANA timezone, such as America/Los_Angeles") from exc
        return value.strip()

    @field_validator("preference_statement", "timezone")
    @classmethod
    def strip_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Value cannot be blank")
        return normalized

    @field_validator("cadence_days")
    @classmethod
    def validate_days(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("Cadence days must be between 0 and 6")
        return sorted(set(value))


class DeliveryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cadence_days: list[int] = Field(min_length=1, max_length=7)
    recommendation_count: int = Field(ge=1, le=10)
    timezone: str | None = Field(default=None, min_length=1, max_length=80)
    delivery_hour: int | None = Field(default=None, ge=0, le=23)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        return ProfileUpdate.valid_timezone(value) if value is not None else None

    @field_validator("cadence_days")
    @classmethod
    def validate_days(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("Cadence days must be between 0 and 6")
        return sorted(set(value))


class PreferenceMemoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preference_statement: str = Field(min_length=1, max_length=5000)
    expected_version: int = Field(ge=1)

    @field_validator("preference_statement")
    @classmethod
    def strip_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Value cannot be blank")
        return normalized


class Profile(ProfileUpdate):
    version: int
    rendered_markdown: str
    updated_at: datetime


class ChannelCreate(BaseModel):
    url: AnyHttpUrl = Field(max_length=2048)

    @field_validator("url")
    @classmethod
    def require_youtube(cls, value: AnyHttpUrl) -> AnyHttpUrl:
        if value.host not in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
            raise ValueError("Use a YouTube channel or video URL")
        return value


class Channel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    url: str
    thumbnail_url: str | None
    is_default: bool
    created_at: datetime


class FeedbackCreate(BaseModel):
    rating: Literal["up", "down"]
    detail: str | None = Field(default=None, max_length=2000)

    @field_validator("detail")
    @classmethod
    def normalize_detail(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class Recommendation(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    video_id: UUID
    title: str
    speaker: str | None
    channel_name: str
    youtube_url: str
    thumbnail_url: str | None
    published_at: datetime | None
    duration_seconds: int | None
    rationale: str
    evidence: dict
    rating: Literal["up", "down"] | None
    clicked_at: datetime | None
    delivered_at: datetime | None
    created_at: datetime


class Metrics(BaseModel):
    delivered: int
    clicked: int
    rated_up: int
    rated_down: int
    click_through_rate: float
    thumbs_up_share: float


class PipelineStatus(BaseModel):
    videos: int
    embedded_videos: int
    embedding_backfill_remaining: int
    embedding_failures: int
    last_ingestion_status: str | None
    last_ingestion_at: datetime | None
    last_ingestion_videos_seen: int


class AnnotationCard(BaseModel):
    profile_id: UUID
    video_id: UUID
    summary: str
    topics: list[str]
    title: str
    description: str
    thumbnail_url: str | None = None


class AnnotationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: UUID
    video_id: UUID
    label: Literal["yes", "no", "unsure"]
    rationale: str | None = Field(default=None, max_length=1000)

    @field_validator("rationale")
    @classmethod
    def normalize_rationale(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class AnnotationAssessment(BaseModel):
    predicted_fit: Literal["yes", "no", "unsure"]
    close_call: bool
    decision_summary: str


class AnnotationResult(AnnotationCreate):
    id: UUID
    created_at: datetime
    assessment: AnnotationAssessment | None = None


class AnnotationStats(BaseModel):
    completed: int
    remaining: int
