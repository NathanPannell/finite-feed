from datetime import UTC, datetime


def reserve_request(conn, provider: str, limit: int) -> None:
    """Atomically reserve quota before calling a provider; failed calls also count."""
    if limit <= 0:
        raise ValueError(f"{provider} daily request budget exhausted")
    row = conn.execute(
        """INSERT INTO provider_daily_usage (provider, usage_date, requests)
        VALUES (%s, %s, 1)
        ON CONFLICT (provider, usage_date) DO UPDATE
        SET requests = provider_daily_usage.requests + 1
        WHERE provider_daily_usage.requests < %s RETURNING requests""",
        (provider, datetime.now(UTC).date(), limit),
    ).fetchone()
    conn.commit()
    if not row:
        raise ValueError(f"{provider} daily request budget exhausted")
