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
    delivery_retry_minutes: int = Field(default=60, ge=15, alias="DELIVERY_RETRY_MINUTES")
    ingestion_interval_hours: int = Field(default=6, ge=1, alias="INGESTION_INTERVAL_HOURS")
    youtube_page_limit: int = Field(default=2, ge=1, le=10, alias="YOUTUBE_PAGE_LIMIT")
    youtube_api_key: str = Field(default="", alias="YOUTUBE_API_KEY")
    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")
    openrouter_model: str = Field(default="google/gemma-4-31b-it:free", alias="OPENROUTER_MODEL")
    openrouter_base_url: str = Field(default="https://openrouter.ai/api/v1", alias="OPENROUTER_BASE_URL")
    embedding_model: str = Field(default="Snowflake/snowflake-arctic-embed-xs", alias="EMBEDDING_MODEL")
    embedding_model_revision: str = Field(
        default="d8c86521100d3556476a063fc2342036d45c106f", alias="EMBEDDING_MODEL_REVISION"
    )
    embedding_dimensions: int = Field(default=384, alias="EMBEDDING_DIMENSIONS")
    embedding_batch_size: int = Field(default=32, ge=1, le=256, alias="EMBEDDING_BATCH_SIZE")
    embedding_cache_dir: str | None = Field(default=None, alias="EMBEDDING_CACHE_DIR")
    embedding_offline: bool = Field(default=False, alias="EMBEDDING_OFFLINE")
    telegram_production_bot_token: str = Field(default="", alias="TELEGRAM_PRODUCTION_BOT_TOKEN")
    telegram_developer_bot_token: str = Field(default="", alias="TELEGRAM_DEVELOPER_BOT_TOKEN")
    telegram_webhook_secret: str = Field(default="", alias="TELEGRAM_WEBHOOK_SECRET")
    telegram_production_chat_id: str = Field(default="", alias="TELEGRAM_PRODUCTION_CHAT_ID")
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

    @property
    def production_chat_id(self) -> int | None:
        if not self.telegram_production_chat_id:
            return None
        if not self.telegram_production_chat_id.lstrip("-").isdigit():
            raise RuntimeError("TELEGRAM_PRODUCTION_CHAT_ID must be a numeric Telegram ID")
        return int(self.telegram_production_chat_id)

    @property
    def developer_user_ids(self) -> set[int]:
        values = [value.strip() for value in self.developer_telegram_user_ids.split(",") if value.strip()]
        if any(not value.lstrip("-").isdigit() for value in values):
            raise RuntimeError("DEVELOPER_TELEGRAM_USER_IDS must contain only numeric Telegram IDs")
        return {int(value) for value in values}


@lru_cache
def get_settings() -> Settings:
    return Settings()
