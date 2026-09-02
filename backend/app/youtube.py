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
        params: dict[str, str] = {"part": "snippet,contentDetails"}
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
        return ChannelDetails(
            youtube_channel_id=item["id"],
            name=item["snippet"]["title"],
            uploads_playlist_id=item["contentDetails"]["relatedPlaylists"]["uploads"],
        )

    def list_uploads(self, playlist_id: str, page_limit: int = 2) -> list[YouTubeVideo]:
        video_ids: list[str] = []
        page_token: str | None = None
        for _ in range(page_limit):
            params: dict[str, object] = {
                "part": "contentDetails", "playlistId": playlist_id, "maxResults": 50,
            }
            if page_token:
                params["pageToken"] = page_token
            data = self._get("/playlistItems", **params)
            video_ids.extend(item["contentDetails"]["videoId"] for item in data.get("items", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        videos: list[YouTubeVideo] = []
        for start in range(0, len(video_ids), 50):
            data = self._get(
                "/videos", part="snippet,contentDetails,statistics",
                id=",".join(video_ids[start:start + 50]), maxResults=50,
            )
            for item in data.get("items", []):
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
                ))
        return videos

    def close(self) -> None:
        self.client.close()
