from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from backend.app.auth import AuthConfigurationError, InvalidAuthToken, NeonTokenVerifier


AUDIENCE = "https://auth.example.test"
ISSUER = f"{AUDIENCE}/app/auth"
PRIVATE_KEY = Ed25519PrivateKey.generate()


class StaticJWKClient:
    def get_signing_key_from_jwt(self, _: str):
        return SimpleNamespace(key=PRIVATE_KEY.public_key())


class UnavailableJWKClient:
    def get_signing_key_from_jwt(self, _: str):
        raise jwt.PyJWKClientConnectionError("unavailable")


def make_token(**overrides: object) -> str:
    now = datetime.now(timezone.utc)
    claims = {
        "sub": "google-user-1",
        "email": "viewer@example.com",
        "name": "Example Viewer",
        "image": "https://example.com/viewer.png",
        "iat": now,
        "exp": now + timedelta(minutes=15),
        "iss": ISSUER,
        "aud": AUDIENCE,
        **overrides,
    }
    return jwt.encode(claims, PRIVATE_KEY, algorithm="EdDSA", headers={"kid": "test-key"})


def verifier() -> NeonTokenVerifier:
    return NeonTokenVerifier(ISSUER, jwks_client=StaticJWKClient())


def test_verified_token_builds_stable_server_side_identity() -> None:
    identity = verifier().verify(make_token())
    assert identity.annotator_id == uuid5(NAMESPACE_URL, f"{ISSUER}:google-user-1")
    assert identity.email == "viewer@example.com"
    assert identity.name == "Example Viewer"


def test_expired_token_is_rejected() -> None:
    past = datetime.now(timezone.utc) - timedelta(minutes=20)
    with pytest.raises(InvalidAuthToken, match="invalid or expired"):
        verifier().verify(make_token(iat=past, exp=past + timedelta(minutes=15)))


def test_wrong_issuer_is_rejected() -> None:
    with pytest.raises(InvalidAuthToken, match="invalid or expired"):
        verifier().verify(make_token(iss="https://attacker.example"))


def test_missing_identity_claim_is_rejected() -> None:
    with pytest.raises(InvalidAuthToken, match="invalid or expired"):
        verifier().verify(make_token(email=None))


def test_jwks_outage_is_reported_as_auth_configuration_failure() -> None:
    unavailable = NeonTokenVerifier(ISSUER, jwks_client=UnavailableJWKClient())
    with pytest.raises(AuthConfigurationError, match="temporarily unavailable"):
        unavailable.verify(make_token())


def test_unconfigured_verifier_fails_closed() -> None:
    with pytest.raises(AuthConfigurationError, match="not configured"):
        NeonTokenVerifier("").verify("token")
