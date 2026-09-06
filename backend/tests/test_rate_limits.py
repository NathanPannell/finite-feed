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
