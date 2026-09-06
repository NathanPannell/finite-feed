"""Read provider account limits without exposing credentials or making model calls."""
import json
import os
import urllib.request

request = urllib.request.Request(
    "https://openrouter.ai/api/v1/key",
    headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
)
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.load(response)["data"]
    fields = ("is_free_tier", "limit", "limit_remaining", "usage_daily")
    print("OpenRouter account quota: " + json.dumps({key: data.get(key) for key in fields}))
except Exception as error:
    print("OpenRouter quota check unavailable: " + type(error).__name__)
