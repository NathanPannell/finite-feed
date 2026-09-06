import json

import httpx
import pytest

from backend.app.openrouter import FREE_FALLBACK_MODEL, FREE_PRIMARY_MODEL, OpenRouterClient


@pytest.mark.parametrize("resolved_model", [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL])
def test_free_fallback_uses_one_request_and_preserves_actual_model(resolved_model):
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"model": resolved_model, "choices": [{"message": {"content": '{"video_id": "talk", "rationale": "A precise fit."}'}}]})
    client = OpenRouterClient("test", FREE_PRIMARY_MODEL, "https://example.com", "https://example.com")
    client.client.close()
    client.client = httpx.Client(transport=httpx.MockTransport(respond), base_url="https://example.com")
    try:
        choice = client.choose("football", [{"video_id": "talk"}])
        assert choice.model == resolved_model
        assert len(requests) == 1
        assert requests[0]["models"] == [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL]
        assert all(model.endswith(":free") for model in requests[0]["models"])
        assert requests[0]["max_tokens"] == 350
        assert "model" not in requests[0]
    finally:
        client.close()


def test_custom_model_pin_is_not_changed_and_exhaustion_is_not_retried():
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(429, json={"error": {"message": "rate limited"}})
    client = OpenRouterClient("test", "custom/model", "https://example.com", "https://example.com")
    client.client.close()
    client.client = httpx.Client(transport=httpx.MockTransport(respond), base_url="https://example.com")
    try:
        with pytest.raises(httpx.HTTPStatusError):
            client.choose("football", [{"video_id": "talk"}])
        assert len(requests) == 1
        assert requests[0]["model"] == "custom/model"
        assert "models" not in requests[0]
    finally:
        client.close()
