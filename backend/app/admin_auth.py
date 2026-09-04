from functools import lru_cache
from typing import Any

import jwt
from fastapi import Depends, Header, HTTPException, status
from jwt import InvalidTokenError, PyJWKClient

from backend.app.settings import Settings, get_settings


class OidcConfigurationError(RuntimeError):
    pass


def oidc_contract(settings: Settings) -> tuple[str, str, str, str]:
    team = settings.vercel_oidc_team_slug.strip()
    project = settings.vercel_oidc_project_name.strip()
    environment = settings.vercel_oidc_environment.strip()
    mode = settings.vercel_oidc_issuer_mode.strip().lower()
    if not team or not project or environment not in {"development", "preview", "production"}:
        raise OidcConfigurationError("Vercel OIDC trust is not configured")
    if mode not in {"team", "global"}:
        raise OidcConfigurationError("VERCEL_OIDC_ISSUER_MODE must be team or global")
    issuer = f"https://oidc.vercel.com/{team}" if mode == "team" else "https://oidc.vercel.com"
    audience = f"https://vercel.com/{team}"
    subject = f"owner:{team}:project:{project}:environment:{environment}"
    return issuer, audience, subject, f"{issuer}/.well-known/jwks"


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_keys=True, lifespan=300)


def verify_oidc_token(
    token: str,
    settings: Settings,
    jwks_client: PyJWKClient | None = None,
) -> dict[str, Any]:
    issuer, audience, subject, jwks_url = oidc_contract(settings)
    client = jwks_client or _jwks_client(jwks_url)
    signing_key = client.get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience=audience,
        issuer=issuer,
        subject=subject,
        options={"require": ["exp", "iat", "nbf", "iss", "aud", "sub"]},
    )
    if (
        claims.get("owner") != settings.vercel_oidc_team_slug.strip()
        or claims.get("project") != settings.vercel_oidc_project_name.strip()
        or claims.get("environment") != settings.vercel_oidc_environment.strip()
    ):
        raise InvalidTokenError("Vercel deployment claims do not match")
    return claims


def require_admin(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return verify_oidc_token(token, settings)
    except OidcConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin authentication",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
