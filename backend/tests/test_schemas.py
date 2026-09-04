import pytest
from pydantic import ValidationError

from backend.app.schemas import ChannelCreate, ProfileUpdate


def test_profile_normalizes_schedule() -> None:
    profile = ProfileUpdate(
        preference_statement="  practical AI systems  ", cadence_days=[4, 1, 4]
    )
    assert profile.preference_statement == "practical AI systems"
    assert profile.cadence_days == [1, 4]


def test_channel_requires_youtube_url() -> None:
    with pytest.raises(ValidationError, match="YouTube"):
        ChannelCreate(url="https://example.com/channel")

    assert str(ChannelCreate(url="https://youtu.be/video-id").url).startswith("https://youtu.be/")
