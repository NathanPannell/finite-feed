from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

import jwt
from jwt import PyJWKClient, PyJWKClientConnectionError


class AuthConfigurationError(RuntimeError):
    pass


class InvalidAuthToken(ValueError):
    pass


@dataclass(frozen=True)
class AuthenticatedAnnotator:
    annotator_id: UUID
    issuer: str
    subject: str
    email: str
    name: str | None
    image_url: str | None


class NeonTokenVerifier:
    def __init__(self, base_url: str, jwks_client: PyJWKClient | None = None):
        self.base_url = base_url.rstrip("/")
        parsed = urlsplit(self.base_url)
        self.audience = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
        self.issuer = self.base_url if self.audience else ""
        self._jwks_client = jwks_client or (
            PyJWKClient(f"{self.base_url}/.well-known/jwks.json", cache_keys=True, lifespan=300)
            if self.base_url
            else None
        )

    def verify(self, token: str) -> AuthenticatedAnnotator:
        if not self._jwks_client or not self.issuer:
            raise AuthConfigurationError("Neon Auth is not configured")
        try:
            signing_key = self._jwks_client.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["EdDSA"],
                issuer=self.issuer,
                audience=self.audience,
                options={"require": ["exp", "iat", "iss", "aud", "sub", "email"]},
            )
        except PyJWKClientConnectionError as exc:
            raise AuthConfigurationError("The sign-in service is temporarily unavailable") from exc
        except jwt.PyJWTError as exc:
            raise InvalidAuthToken("The sign-in token is invalid or expired") from exc
        except Exception as exc:
            raise InvalidAuthToken("The sign-in token could not be verified") from exc

        subject = claims.get("sub")
        email = claims.get("email")
        if not isinstance(subject, str) or not subject or not isinstance(email, str) or not email:
            raise InvalidAuthToken("The sign-in token is missing identity claims")
        name = claims.get("name")
        image_url = claims.get("image")
        return AuthenticatedAnnotator(
            annotator_id=uuid5(NAMESPACE_URL, f"{self.issuer}:{subject}"),
            issuer=self.issuer,
            subject=subject,
            email=email,
            name=name if isinstance(name, str) and name else None,
            image_url=image_url if isinstance(image_url, str) and image_url else None,
        )
