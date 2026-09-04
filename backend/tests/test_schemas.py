import pytest
from pydantic import ValidationError

from backend.app.schemas import ChannelCreate, DeliveryUpdate, PreferenceMemoryUpdate, ProfileUpdate


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


def test_scoped_profile_updates_normalize_without_accepting_hidden_fields() -> None:
    delivery = DeliveryUpdate(cadence_days=[5, 2, 5], recommendation_count=3)
    memory = PreferenceMemoryUpdate(preference_statement="  useful systems  ", expected_version=4)

    assert delivery.cadence_days == [2, 5]
    assert memory.preference_statement == "useful systems"
    with pytest.raises(ValidationError, match="Extra inputs"):
        DeliveryUpdate(
            cadence_days=[2, 5],
            recommendation_count=3,
            timezone="Stale/Timezone",
        )
