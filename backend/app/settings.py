from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str | None = Field(default=None, alias="DATABASE_URL")
    database_url_unpooled: str | None = Field(default=None, alias="DATABASE_URL_UNPOOLED")
    preview_database_url: str | None = Field(default=None, alias="PREVIEW_DATABASE_URL")
    preview_database_url_unpooled: str | None = Field(default=None, alias="PREVIEW_DATABASE_URL_UNPOOLED")
    railway_environment_name: str | None = Field(default=None, alias="RAILWAY_ENVIRONMENT_NAME")
    frontend_origins: str = Field(default="http://localhost:3000", alias="FRONTEND_ORIGINS")
    app_commit_sha: str = Field(default="local", alias="APP_COMMIT_SHA")
    worker_poll_seconds: int = Field(default=60, ge=15, alias="WORKER_POLL_SECONDS")
    youtube_api_key: str = Field(default="", alias="YOUTUBE_API_KEY")
    model_api_key: str = Field(default="", alias="MODEL_API_KEY")
    model_name: str = Field(default="", alias="MODEL_NAME")
    telegram_production_bot_token: str = Field(default="", alias="TELEGRAM_PRODUCTION_BOT_TOKEN")
    telegram_developer_bot_token: str = Field(default="", alias="TELEGRAM_DEVELOPER_BOT_TOKEN")
    telegram_webhook_secret: str = Field(default="", alias="TELEGRAM_WEBHOOK_SECRET")
    developer_telegram_user_ids: str = Field(default="", alias="DEVELOPER_TELEGRAM_USER_IDS")
    public_app_url: str = Field(default="http://localhost:8000", alias="PUBLIC_APP_URL")

    @property
    def is_preview(self) -> bool:
        name = (self.railway_environment_name or "").lower()
        return name.startswith("pr-") or "-pr-" in name

    @property
    def effective_database_url(self) -> str:
        if self.is_preview:
            if not self.preview_database_url:
                raise RuntimeError("Railway preview environments require PREVIEW_DATABASE_URL; DATABASE_URL is intentionally ignored.")
            return self.preview_database_url
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is required outside preview environments")
        return self.database_url

    @property
    def effective_migration_database_url(self) -> str:
        if self.is_preview:
            if not self.preview_database_url_unpooled:
                raise RuntimeError("Railway preview migrations require PREVIEW_DATABASE_URL_UNPOOLED.")
            return self.preview_database_url_unpooled
        if self.railway_environment_name and not self.database_url_unpooled:
            raise RuntimeError("Railway production migrations require DATABASE_URL_UNPOOLED.")
        return self.database_url_unpooled or self.effective_database_url

    @property
    def allowed_origins(self) -> list[str]:
        return [value.strip() for value in self.frontend_origins.split(",") if value.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
