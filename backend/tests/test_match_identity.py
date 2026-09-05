from uuid import uuid4

from fastapi import Request, Response

from backend.app.match_identity import COOKIE_NAME, issue_reviewer_token, reviewer_identity, verify_reviewer_token
from backend.app.settings import Settings


SECRET = "a-test-secret-that-is-safely-over-32-bytes"


def test_signed_reviewer_token_round_trip() -> None:
    reviewer_id = uuid4()
    token = issue_reviewer_token(reviewer_id, SECRET)
    assert str(reviewer_id) not in token
    assert verify_reviewer_token(token, SECRET) == reviewer_id


def test_tampered_reviewer_token_is_rejected() -> None:
    token = issue_reviewer_token(uuid4(), SECRET)
    assert verify_reviewer_token(token[:-1] + ("A" if token[-1] != "A" else "B"), SECRET) is None


def test_server_issues_long_lived_http_only_pseudonymous_cookie() -> None:
    request = Request({"type": "http", "headers": []})
    response = Response()
    reviewer_id = reviewer_identity(
        request,
        response,
        Settings(_env_file=None, MATCH_LAB_COOKIE_SECRET=SECRET),
    )
    cookie = response.headers["set-cookie"]
    assert COOKIE_NAME in cookie
    assert str(reviewer_id) not in cookie
    assert "HttpOnly" in cookie
    assert "Max-Age=63072000" in cookie
