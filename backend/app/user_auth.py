"""Live Neon session verification; identity is never taken from request user IDs."""
from datetime import datetime, timezone
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, HTTPException, Request
from psycopg import Connection

from backend.app.db import connection
from backend.app.settings import get_settings


def verified_identity(request: Request) -> dict:
    settings = get_settings()
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and origin and origin not in settings.allowed_origins:
        raise HTTPException(403, "Invalid request origin")
    cookie = request.headers.get("cookie", "")
    if not cookie:
        raise HTTPException(401, "Sign in to continue")
    if not settings.neon_auth_base_url:
        raise HTTPException(503, "Account sign-in is not configured")
    # Always consult Neon, bypassing both SDK and Better Auth cookie caches so
    # logout/revocation takes effect on the next personal API request.
    try:
        response = httpx.get(
            settings.neon_auth_base_url.rstrip("/") + "/get-session",
            params={"disableCookieCache": "true"},
            headers={"Cookie": cookie}, timeout=10,
        )
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(401, "Session could not be verified. Sign in again.") from exc
    if not isinstance(data, dict):
        raise HTTPException(401, "Sign in to continue")
    user, session = data.get("user"), data.get("session")
    try:
        expiry = datetime.fromisoformat(session["expiresAt"].replace("Z", "+00:00"))
        valid = (isinstance(user["id"], str) and bool(user["id"])
                 and session["userId"] == user["id"] and expiry > datetime.now(timezone.utc))
    except (TypeError, KeyError, ValueError):
        valid = False
    if not valid:
        raise HTTPException(401, "Session expired. Sign in again.")
    return user


def current_user(identity: dict = Depends(verified_identity), conn: Connection = Depends(connection)) -> UUID:
    subject = identity["id"]
    # A transaction lock serializes first-login provisioning without email matching.
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("account:" + subject,))
    row = conn.execute("SELECT id, deleted_at FROM app_users WHERE auth_subject = %s", (subject,)).fetchone()
    if row and row["deleted_at"]:
        raise HTTPException(403, "This account has been deleted")
    if not row:
        user_id = uuid4()
        conn.execute(
            "INSERT INTO app_users(id, display_name, auth_subject, email) VALUES (%s, %s, %s, %s)",
            (user_id, str(identity.get("name") or "Member")[:200], subject, identity.get("email")),
        )
        statement = "Show me unusually useful ideas. I will add my interests and exclusions in settings."
        conn.execute(
            "INSERT INTO preference_versions(id,user_id,version,preference_statement,rendered_markdown,source) VALUES (%s,%s,1,%s,%s,'onboarding')",
            (uuid4(), user_id, statement, "# Current preferences\n\n" + statement),
        )
        conn.execute("INSERT INTO user_channel_follows(user_id,channel_id) SELECT %s,id FROM tracked_channels WHERE is_default AND is_active", (user_id,))
    else:
        user_id = row["id"]
    conn.commit()
    # Serialize personal mutations with deletion and concurrent settings edits.
    # Recheck after acquiring the row lock: deletion may have won the race.
    active = conn.execute("SELECT deleted_at FROM app_users WHERE id=%s FOR UPDATE", (user_id,)).fetchone()
    if not active or active["deleted_at"]:
        raise HTTPException(403, "This account has been deleted")
    return user_id
