import re
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlparse

import httpx

YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3"
DURATION_PATTERN = re.compile(r"P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?")


@dataclass(frozen=True)
class ChannelDetails:
    youtube_channel_id: str
    name: str
    uploads_playlist_id: str
    thumbnail_url: str | None = None
    description: str = ""
    subscriber_count: int | None = None
    public_video_count: int | None = None


@dataclass(frozen=True)
class YouTubeVideo:
    youtube_video_id: str
    channel_name: str
    title: str
    speaker: str | None
    youtube_url: str
    thumbnail_url: str | None
    description: str
    published_at: datetime | None
    duration_seconds: int | None
    view_count: int
    default_language: str | None = None
    default_audio_language: str | None = None


@dataclass(frozen=True)
class UploadPage:
    videos: list[YouTubeVideo]
    next_page_token: str | None


def parse_duration(value: str | None) -> int | None:
    if not value:
        return None
    match = DURATION_PATTERN.fullmatch(value)
    if not match:
        return None
    parts = {name: int(amount or 0) for name, amount in match.groupdict().items()}
    return parts["days"] * 86400 + parts["hours"] * 3600 + parts["minutes"] * 60 + parts["seconds"]


def infer_speaker(title: str) -> str | None:
    parts = [part.strip() for part in title.split("|")]
    if len(parts) >= 2 and parts[-1].lower() in {"ted", "tedx", "ted talk"}:
        return parts[-2] or None
    return None


class YouTubeClient:
    def __init__(self, api_key: str, timeout_seconds: float = 20.0):
        self.api_key = api_key
        self.client = httpx.Client(base_url=YOUTUBE_API_URL, timeout=timeout_seconds)

    def _get(self, path: str, **params: object) -> dict:
        response = self.client.get(path, params={**params, "key": self.api_key})
        response.raise_for_status()
        return response.json()

    def resolve_channel(self, url: str, known_id: str | None = None) -> ChannelDetails:
        path = urlparse(url).path.strip("/")
        params: dict[str, str] = {"part": "snippet,contentDetails,statistics"}
        if known_id:
            params["id"] = known_id
        elif path.startswith("channel/"):
            params["id"] = path.split("/", 1)[1]
        elif path.startswith("@"):
            params["forHandle"] = path[1:]
        else:
            raise ValueError(f"Unsupported YouTube channel URL: {url}")
        items = self._get("/channels", **params).get("items", [])
        if not items:
            raise ValueError(f"YouTube channel was not found: {url}")
        item = items[0]
        snippet = item["snippet"]
        statistics = item.get("statistics", {})
        thumbnails = snippet.get("thumbnails", {})
        thumbnail = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default")
        return ChannelDetails(
            youtube_channel_id=item["id"],
            name=snippet["title"],
            uploads_playlist_id=item["contentDetails"]["relatedPlaylists"]["uploads"],
            thumbnail_url=thumbnail.get("url") if thumbnail else None,
            description=snippet.get("description", ""),
            subscriber_count=(
                int(statistics["subscriberCount"])
                if statistics.get("subscriberCount") is not None
                else None
            ),
            public_video_count=(
                int(statistics["videoCount"])
                if statistics.get("videoCount") is not None
                else None
            ),
        )

    def list_upload_page(
        self,
        playlist_id: str,
        page_token: str | None = None,
        max_results: int = 50,
    ) -> UploadPage:
        if not 1 <= max_results <= 50:
            raise ValueError("max_results must be between 1 and 50")
        params: dict[str, object] = {
            "part": "contentDetails", "playlistId": playlist_id, "maxResults": max_results,
        }
        if page_token:
            params["pageToken"] = page_token
        page = self._get("/playlistItems", **params)
        video_ids = [item["contentDetails"]["videoId"] for item in page.get("items", [])]
        videos: list[YouTubeVideo] = []
        for start in range(0, len(video_ids), 50):
            batch_ids = video_ids[start:start + 50]
            data = self._get(
                "/videos", part="snippet,contentDetails,statistics",
                id=",".join(batch_ids), maxResults=50,
            )
            items_by_id = {item["id"]: item for item in data.get("items", [])}
            for video_id in batch_ids:
                item = items_by_id.get(video_id)
                if item is None:
                    continue
                snippet = item["snippet"]
                thumbnails = snippet.get("thumbnails", {})
                thumbnail = thumbnails.get("maxres") or thumbnails.get("high") or thumbnails.get("default")
                videos.append(YouTubeVideo(
                    youtube_video_id=item["id"],
                    channel_name=snippet["channelTitle"],
                    title=snippet["title"],
                    speaker=infer_speaker(snippet["title"]),
                    youtube_url=f"https://www.youtube.com/watch?v={item['id']}",
                    thumbnail_url=thumbnail.get("url") if thumbnail else None,
                    description=snippet.get("description", ""),
                    published_at=datetime.fromisoformat(snippet["publishedAt"].replace("Z", "+00:00")) if snippet.get("publishedAt") else None,
                    duration_seconds=parse_duration(item.get("contentDetails", {}).get("duration")),
                    view_count=int(item.get("statistics", {}).get("viewCount", 0)),
                    default_language=snippet.get("defaultLanguage"),
                    default_audio_language=snippet.get("defaultAudioLanguage"),
                ))
        return UploadPage(videos=videos, next_page_token=page.get("nextPageToken"))

    def list_uploads(self, playlist_id: str, page_limit: int = 2) -> list[YouTubeVideo]:
        videos: list[YouTubeVideo] = []
        page_token: str | None = None
        for _ in range(page_limit):
            page = self.list_upload_page(playlist_id, page_token=page_token, max_results=50)
            videos.extend(page.videos)
            page_token = page.next_page_token
            if not page_token:
                break
        return videos

    def close(self) -> None:
        self.client.close()
