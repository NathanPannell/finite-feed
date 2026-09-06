from backend.app.rate_limits import WindowLimiter


def test_window_exhaustion_recovers_and_other_peers_are_independent():
    limiter = WindowLimiter()
    assert limiter.allow("a", 2, now=0)
    assert limiter.allow("a", 2, now=1)
    assert not limiter.allow("a", 2, now=59)
    assert limiter.allow("b", 2, now=59)
    assert limiter.allow("a", 2, now=60)


def test_memory_is_bounded():
    limiter = WindowLimiter(maximum_keys=2)
    for key in range(100):
        assert limiter.allow(key, 2, now=0)
    assert len(limiter.entries) == 2

def test_channel_resolver_stops_before_network_when_budget_is_exhausted(monkeypatch):
    from backend.app import admin as admin_module
    from backend.app.settings import Settings
    from backend.app.youtube import YouTubeClient
    def database():
        yield object()
    monkeypatch.setattr(admin_module, "connection", database)
    def exhausted(conn, provider, limit):
        assert provider == "youtube"
        raise ValueError("youtube daily request budget exhausted")
    monkeypatch.setattr(admin_module, "reserve_request", exhausted)
    monkeypatch.setattr(YouTubeClient, "close", lambda self: None)
    import pytest
    with pytest.raises(ValueError, match="budget exhausted"):
        admin_module.resolve_youtube_channel("https://youtube.com/@TED", Settings(YOUTUBE_API_KEY="test"))
