import json

import httpx
import pytest

from backend.app.openrouter import FREE_ALTERNATE_MODEL, FREE_FALLBACK_MODEL, FREE_PRIMARY_MODEL, OpenRouterClient


@pytest.mark.parametrize("resolved_model", [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL, FREE_ALTERNATE_MODEL])
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
        assert requests[0]["models"] == [FREE_PRIMARY_MODEL, FREE_FALLBACK_MODEL, FREE_ALTERNATE_MODEL]
        assert all(model.endswith(":free") for model in requests[0]["models"])
        assert requests[0]["max_tokens"] == 350
        assert requests[0]["reasoning"] == {"enabled": False}
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
        assert "reasoning" not in requests[0]
    finally:
        client.close()


def test_missing_video_id_is_malformed_instead_of_an_abstention():
    client = OpenRouterClient("test", "custom/model", "https://example.com", "https://example.com")
    client.client.close()
    client.client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        "model": "custom/model",
        "choices": [{"message": {"content": '{"rationale":"No selection field."}'}}],
    })), base_url="https://example.com")
    try:
        with pytest.raises(ValueError, match="omitted its video selection"):
            client.choose("useful talks", [{"video_id": "nearest"}])
    finally:
        client.close()


@pytest.mark.parametrize("content", [
    '{"video_id":null,"rationale":null}',
    '{"video_id":null,"rationale":{"text":"no"}}',
])
def test_non_string_rationale_is_malformed(content):
    client = OpenRouterClient("test", "custom/model", "https://example.com", "https://example.com")
    client.client.close()
    client.client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        "model": "custom/model", "choices": [{"message": {"content": content}}],
    })), base_url="https://example.com")
    try:
        with pytest.raises(ValueError, match="omitted its rationale"):
            client.choose("useful talks", [{"video_id": "nearest"}])
    finally:
        client.close()


@pytest.mark.parametrize("error, expected", [
    ({"message": "Rate limit exceeded: free-models-per-day. SECRET"}, "provider_daily_limit"),
    ({"message": "Daily request limit reached SECRET"}, "provider_daily_limit"),
    ({"message": "Requests per minute exceeded SECRET"}, "provider_minute_limit"),
    ({"message": "Provider returned error", "metadata": {"provider_name": "SECRET", "raw": "Temporarily rate-limited upstream SECRET"}}, "provider_upstream_limit"),
    ({"message": "Model is temporarily rate-limited upstream SECRET"}, "provider_upstream_limit"),
    ({"message": "SECRET"}, "provider_http_429"),
    (None, "provider_http_429"),
])
def test_provider_rate_limit_diagnostics_are_fixed_and_secret_safe(error, expected):
    from backend.app.openrouter import provider_failure
    request = httpx.Request("POST", "https://example.com/SECRET")
    response = httpx.Response(429, json={"error": error}, request=request)
    failure = httpx.HTTPStatusError("SECRET", request=request, response=response)
    code, detail = provider_failure(failure)
    assert code == expected
    assert "SECRET" not in code + detail


def test_malformed_provider_error_stays_generic():
    from backend.app.openrouter import provider_failure
    request = httpx.Request("POST", "https://example.com")
    response = httpx.Response(429, content=b"<html>SECRET</html>", request=request)
    code, detail = provider_failure(httpx.HTTPStatusError("SECRET", request=request, response=response))
    assert code == "provider_http_429"
    assert "SECRET" not in detail
