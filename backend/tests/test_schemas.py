import pytest
from pydantic import ValidationError

from backend.app.schemas import AnnotationCreate, ChannelCreate, ProfileUpdate


def test_profile_normalizes_schedule() -> None:
    profile = ProfileUpdate(
        preference_statement="  practical AI systems  ", cadence_days=[4, 1, 4]
    )
    assert profile.preference_statement == "practical AI systems"
    assert profile.cadence_days == [1, 4]


def test_channel_requires_youtube_url() -> None:
    with pytest.raises(ValidationError, match="youtube.com"):
        ChannelCreate(name="Not YouTube", url="https://example.com/channel")


def test_annotation_rejects_client_controlled_reviewer_identity() -> None:
    with pytest.raises(ValidationError, match="annotator_id"):
        AnnotationCreate(
            profile_id="30000000-0000-4000-8000-000000000001",
            video_id="40000000-0000-4000-8000-000000000001",
            annotator_id="50000000-0000-4000-8000-000000000001",
            label="yes",
        )
