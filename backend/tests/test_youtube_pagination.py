import pytest

from backend.app.youtube import YouTubeClient


class StubYouTubeClient(YouTubeClient):
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def _get(self, path: str, **params: object) -> dict:
        self.calls.append((path, params))
        if path == "/channels":
            return {"items": [{
                "id": "UC123",
                "snippet": {
                    "title": "Example",
                    "description": "Channel description",
                    "thumbnails": {"high": {"url": "https://example.test/channel.jpg"}},
                },
                "contentDetails": {"relatedPlaylists": {"uploads": "UU123"}},
                "statistics": {"subscriberCount": "42", "videoCount": "9"},
            }]}
        if path == "/playlistItems":
            return {
                "items": [{"contentDetails": {"videoId": "video-1"}}],
                "nextPageToken": "next-token",
            }
        return {"items": [{
            "id": "video-1",
            "snippet": {
                "channelTitle": "Example",
                "title": "Example video",
                "description": "Description",
                "defaultLanguage": "en-GB",
                "defaultAudioLanguage": "en-US",
                "publishedAt": "2026-09-01T00:00:00Z",
                "thumbnails": {},
            },
            "contentDetails": {"duration": "PT2M"},
            "statistics": {"viewCount": "12"},
        }]}


def test_resolve_channel_includes_admin_metadata() -> None:
    client = StubYouTubeClient()
    details = client.resolve_channel("https://www.youtube.com/@example")
    assert details.youtube_channel_id == "UC123"
    assert details.thumbnail_url == "https://example.test/channel.jpg"
    assert details.description == "Channel description"
    assert details.subscriber_count == 42
    assert details.public_video_count == 9
    assert client.calls[0][1]["part"] == "snippet,contentDetails,statistics"


def test_upload_page_uses_cursor_and_bounded_page_size() -> None:
    client = StubYouTubeClient()
    page = client.list_upload_page("UU123", page_token="cursor", max_results=7)
    assert page.next_page_token == "next-token"
    assert [video.youtube_video_id for video in page.videos] == ["video-1"]
    assert page.videos[0].default_language == "en-GB"
    assert page.videos[0].default_audio_language == "en-US"
    assert client.calls[0] == (
        "/playlistItems",
        {"part": "contentDetails", "playlistId": "UU123", "maxResults": 7, "pageToken": "cursor"},
    )


@pytest.mark.parametrize("limit", [0, 51])
def test_upload_page_rejects_unbounded_page_size(limit: int) -> None:
    with pytest.raises(ValueError, match="between 1 and 50"):
        StubYouTubeClient().list_upload_page("UU123", max_results=limit)
