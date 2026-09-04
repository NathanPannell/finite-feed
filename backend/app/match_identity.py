import base64
import hashlib
import hmac
from uuid import UUID, uuid4

from fastapi import Request, Response

from backend.app.settings import Settings


COOKIE_NAME = "finite_feed_match_reviewer"
COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2
TOKEN_VERSION = "v1"


def _signature(payload: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def issue_reviewer_token(reviewer_id: UUID, secret: str) -> str:
    encoded_id = base64.urlsafe_b64encode(reviewer_id.bytes).rstrip(b"=").decode("ascii")
    payload = f"{TOKEN_VERSION}.{encoded_id}"
    return f"{payload}.{_signature(payload, secret)}"


def verify_reviewer_token(token: str | None, secret: str) -> UUID | None:
    if not token:
        return None
    try:
        version, encoded_id, supplied_signature = token.split(".")
        payload = f"{version}.{encoded_id}"
        if version != TOKEN_VERSION or not hmac.compare_digest(_signature(payload, secret), supplied_signature):
            return None
        padding = "=" * (-len(encoded_id) % 4)
        return UUID(bytes=base64.urlsafe_b64decode(encoded_id + padding))
    except (ValueError, TypeError):
        return None


def reviewer_identity(request: Request, response: Response, settings: Settings) -> UUID:
    secret = settings.validated_match_lab_cookie_secret
    reviewer_id = verify_reviewer_token(request.cookies.get(COOKIE_NAME), secret)
    if reviewer_id is not None:
        return reviewer_id
    reviewer_id = uuid4()
    response.set_cookie(
        COOKIE_NAME,
        issue_reviewer_token(reviewer_id, secret),
        max_age=COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=settings.match_lab_cookie_secure,
        samesite="none" if settings.match_lab_cookie_secure else "lax",
        path="/api/annotations",
    )
    return reviewer_id
