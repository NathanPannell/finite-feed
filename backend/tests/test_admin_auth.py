from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi import HTTPException
from jwt import InvalidTokenError

from backend.app.admin_auth import oidc_contract, require_admin, verify_oidc_token
from backend.app.settings import Settings


class StaticJwks:
    def __init__(self, key):
        self.key = key

    def get_signing_key_from_jwt(self, _token: str):
        return SimpleNamespace(key=self.key)


@pytest.fixture
def oidc_settings() -> Settings:
    return Settings(
        _env_file=None,
        VERCEL_OIDC_TEAM_SLUG="finite-feed",
        VERCEL_OIDC_PROJECT_NAME="finite-feed-web",
        VERCEL_OIDC_ENVIRONMENT="preview",
    )


def token_for(settings: Settings, **overrides: object) -> tuple[str, object]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    issuer, audience, subject, _ = oidc_contract(settings)
    claims = {
        "iss": issuer,
        "aud": audience,
        "sub": subject,
        "iat": now,
        "nbf": now - timedelta(seconds=1),
        "exp": now + timedelta(minutes=5),
        "owner": settings.vercel_oidc_team_slug,
        "project": settings.vercel_oidc_project_name,
        "environment": settings.vercel_oidc_environment,
        **overrides,
    }
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "test"}), private_key.public_key()


def test_validates_signature_and_all_deployment_claims(oidc_settings: Settings) -> None:
    token, public_key = token_for(oidc_settings)
    claims = verify_oidc_token(token, oidc_settings, StaticJwks(public_key))
    assert claims["project"] == "finite-feed-web"


def test_rejects_wrong_project_claim_even_when_standard_claims_match(oidc_settings: Settings) -> None:
    token, public_key = token_for(oidc_settings, project="another-project")
    with pytest.raises(InvalidTokenError, match="claims do not match"):
        verify_oidc_token(token, oidc_settings, StaticJwks(public_key))


def test_rejects_expired_token(oidc_settings: Settings) -> None:
    expired = datetime.now(timezone.utc) - timedelta(minutes=1)
    token, public_key = token_for(oidc_settings, exp=expired)
    with pytest.raises(jwt.ExpiredSignatureError):
        verify_oidc_token(token, oidc_settings, StaticJwks(public_key))


def test_direct_call_without_bearer_token_is_rejected(oidc_settings: Settings) -> None:
    with pytest.raises(HTTPException) as error:
        require_admin(None, oidc_settings)
    assert error.value.status_code == 401
    assert error.value.headers == {"WWW-Authenticate": "Bearer"}


def test_mounted_admin_route_rejects_direct_call_before_database_access() -> None:
    from backend.app.admin import router

    app = FastAPI()
    app.include_router(router)
    response = TestClient(app).get("/api/admin/summary")
    assert response.status_code == 401
    assert response.json() == {"detail": "Admin authentication required"}


def test_global_issuer_mode_uses_global_jwks() -> None:
    settings = Settings(
        _env_file=None,
        VERCEL_OIDC_TEAM_SLUG="finite-feed",
        VERCEL_OIDC_PROJECT_NAME="finite-feed-web",
        VERCEL_OIDC_ENVIRONMENT="production",
        VERCEL_OIDC_ISSUER_MODE="global",
    )
    issuer, audience, subject, jwks = oidc_contract(settings)
    assert issuer == "https://oidc.vercel.com"
    assert audience == "https://vercel.com/finite-feed"
    assert subject.endswith("environment:production")
    assert jwks == "https://oidc.vercel.com/.well-known/jwks"
