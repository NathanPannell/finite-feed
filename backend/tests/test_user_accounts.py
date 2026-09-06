import hashlib
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from starlette.requests import Request

from backend.app.accounts import account, consume_telegram_link, delete_account, DeleteAccount
from backend.app.main import get_profile, list_channels, record_feedback, remove_channel, track_click
from backend.app.schemas import FeedbackCreate
from backend.app.user_auth import current_user, verified_identity


def test_every_personal_api_denies_anonymous_before_database_access():
    from backend.app.main import app
    client = TestClient(app)
    record = str(uuid4())
    for method, path in (
        ("GET", "/api/account"), ("GET", "/api/account/export"),
        ("DELETE", "/api/account"), ("POST", "/api/account/telegram-link"),
        ("DELETE", "/api/account/telegram"), ("PUT", "/api/account/delivery"),
        ("GET", "/api/profile"), ("PUT", "/api/profile"),
        ("GET", "/api/onboarding"), ("GET", "/api/onboarding/audit"),
        ("PUT", "/api/onboarding/answers"), ("PUT", "/api/onboarding/open-response"),
        ("POST", "/api/onboarding/synthesize"), ("PUT", "/api/onboarding/profile"),
        ("PUT", "/api/onboarding/delivery"), ("POST", "/api/onboarding/complete"),
        ("PUT", "/api/profile/delivery"), ("PUT", "/api/profile/memory"),
        ("GET", "/api/channels"), ("POST", "/api/channels"),
        ("POST", "/api/channels/resolve"), ("DELETE", f"/api/channels/{record}"),
        ("GET", "/api/recommendations"), ("POST", "/api/recommendations/generate"),
        ("POST", f"/api/recommendations/{record}/feedback"),
        ("GET", f"/r/{record}"), ("GET", "/api/metrics"), ("GET", "/api/pipeline/status"),
    ):
        response = client.request(method, path)
        assert response.status_code == 401, (method, path, response.text)


def test_anonymous_identity_fails_before_database():
    with pytest.raises(HTTPException) as error:
        verified_identity(Request({"type": "http", "method": "GET", "headers": []}))
    assert error.value.status_code == 401


def test_unrelated_cookies_never_reach_auth_provider(monkeypatch):
    from backend.app import user_auth
    from backend.app.settings import Settings
    monkeypatch.setattr(user_auth, "get_settings", lambda: Settings(NEON_AUTH_BASE_URL="https://auth.example/auth"))
    def upstream(*args, **kwargs):
        assert kwargs["headers"]["Cookie"] == "__Secure-neon-auth.session_token=test-session"
        assert kwargs["params"] == {"disableCookieCache": "true"}
        class Reply:
            def raise_for_status(self): pass
            def json(self): return None
        return Reply()
    monkeypatch.setattr(user_auth.httpx, "get", upstream)
    with pytest.raises(HTTPException):
        verified_identity(Request({"type": "http", "method": "GET", "headers": [(b"cookie", b"_vercel_jwt=private; __Secure-neon-auth.session_token=test-session; unrelated=private")]}))


@pytest.mark.parametrize("data", [None, {}, {"user": {"id": "a"}, "session": {"userId": "b", "expiresAt": "2099-01-01T00:00:00Z"}}, {"user": {"id": "a"}, "session": {"userId": "a", "expiresAt": "2000-01-01T00:00:00Z"}}])
def test_invalid_revoked_expired_session_denied(monkeypatch, data):
    from backend.app import user_auth
    from backend.app.settings import Settings
    monkeypatch.setattr(user_auth, "get_settings", lambda: Settings(NEON_AUTH_BASE_URL="https://auth.example/auth"))
    class Reply:
        def raise_for_status(self): pass
        def json(self): return data
    monkeypatch.setattr(user_auth.httpx, "get", lambda *a, **kw: Reply())
    with pytest.raises(HTTPException) as error:
        verified_identity(Request({"type": "http", "method": "GET", "headers": [(b"cookie", b"__Secure-neon-auth.session_token=invalid")]}))
    assert error.value.status_code == 401


def test_two_users_cannot_access_records_and_links_are_single_use():
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for account integration")
    ids = []
    video_id = uuid4()
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            identity = {"id": str(uuid4()), "name": "Account test", "email": "same@example.test"}
            first = current_user(identity, conn)
            ids.append(first)
            assert current_user(identity, conn) == first
            assert account(first, conn)["onboarding_completed"] is False
            second = current_user({**identity, "id": str(uuid4())}, conn)
            ids.append(second)
            assert second != first
            channel = list_channels(first,conn)[0]
            remove_channel(channel["id"],second,conn)
            assert channel["id"] in {c["id"] for c in list_channels(first,conn)}
            conn.execute("INSERT INTO videos(id,youtube_video_id,channel_name,title,youtube_url) VALUES (%s,%s,'Test','Test','https://youtube.com/watch?v=test')", (video_id,str(video_id)))
            rec = uuid4()
            conn.execute("INSERT INTO recommendations(id,user_id,video_id,rationale) VALUES (%s,%s,%s,'Test')", (rec,first,video_id))
            conn.commit()
            for call in (lambda: record_feedback(rec,FeedbackCreate(rating="up"),second,conn), lambda: track_click(rec,second,conn)):
                with pytest.raises(HTTPException) as error:
                    call()
                assert error.value.status_code == 404
            raw = str(uuid4())
            conn.execute("INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at) VALUES (%s,%s,%s)", (hashlib.sha256(raw.encode()).hexdigest(),first,datetime.now(timezone.utc)+timedelta(minutes=1)))
            conn.commit()
            chat = int(uuid4().int % 1000000000) + 9000000000
            assert consume_telegram_link(conn,raw,chat) == first
            assert consume_telegram_link(conn,raw,chat) is None
            conn.rollback()
            expired = str(uuid4())
            conflict = str(uuid4())
            for link, user, expiry in ((expired,second,datetime.now(timezone.utc)-timedelta(seconds=1)), (conflict,second,datetime.now(timezone.utc)+timedelta(minutes=1))):
                conn.execute("INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at) VALUES (%s,%s,%s)", (hashlib.sha256(link.encode()).hexdigest(),user,expiry))
            conn.commit()
            assert consume_telegram_link(conn,expired,chat+1) is None
            conn.rollback()
            assert consume_telegram_link(conn,conflict,chat) is None
            conn.rollback()
            assert get_profile(first,conn)["version"] == 1
            conn.execute("INSERT INTO onboarding_sessions(user_id,answers,completed_at) VALUES (%s,'{}',NOW())", (first,))
            conn.execute("INSERT INTO onboarding_audit_logs(id,user_id,step,action) VALUES (%s,%s,'onboarding','completed')", (uuid4(),first))
            conn.execute("UPDATE app_users SET onboarding_completed_at=NOW() WHERE id=%s", (first,))
            conn.commit()
            assert account(first, conn)["onboarding_completed"] is True
            delete_account(DeleteAccount(confirmation="DELETE"),first,conn)
            tombstone = conn.execute("SELECT onboarding_completed_at FROM app_users WHERE id=%s", (first,)).fetchone()
            assert tombstone["onboarding_completed_at"] is None
            assert conn.execute("SELECT 1 FROM onboarding_sessions WHERE user_id=%s", (first,)).fetchone() is None
            assert conn.execute("SELECT 1 FROM onboarding_audit_logs WHERE user_id=%s", (first,)).fetchone() is None
            with pytest.raises(HTTPException) as error:
                current_user(identity,conn)
            assert error.value.status_code == 403
            conn.rollback()
            assert get_profile(second,conn)["version"] == 1
        finally:
            conn.rollback()
            for user_id in ids:
                conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.execute("DELETE FROM videos WHERE id=%s", (video_id,))
            conn.commit()
