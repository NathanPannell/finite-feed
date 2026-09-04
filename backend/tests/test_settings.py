import pytest

from backend.app.settings import Settings


def test_preview_never_falls_back_to_production_database() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    with pytest.raises(RuntimeError, match="PREVIEW_DATABASE_URL"):
        _ = settings.effective_database_url


def test_preview_uses_preview_database() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production",
        PREVIEW_DATABASE_URL="postgresql://preview",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    assert settings.effective_database_url == "postgresql://preview"


def test_preview_migrations_require_direct_database_url() -> None:
    settings = Settings(
        PREVIEW_DATABASE_URL="postgresql://preview-pooled",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    with pytest.raises(RuntimeError, match="PREVIEW_DATABASE_URL_UNPOOLED"):
        _ = settings.effective_migration_database_url


def test_preview_migrations_use_direct_database_url() -> None:
    settings = Settings(
        PREVIEW_DATABASE_URL="postgresql://preview-pooled",
        PREVIEW_DATABASE_URL_UNPOOLED="postgresql://preview-direct",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    assert settings.effective_migration_database_url == "postgresql://preview-direct"


def test_railway_production_migrations_require_direct_database_url() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production-pooled",
        DATABASE_URL_UNPOOLED=None,
        RAILWAY_ENVIRONMENT_NAME="production",
    )
    with pytest.raises(RuntimeError, match="DATABASE_URL_UNPOOLED"):
        _ = settings.effective_migration_database_url


def test_local_migrations_may_use_local_database_url() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://localhost/app",
        DATABASE_URL_UNPOOLED=None,
    )
    assert settings.effective_migration_database_url == "postgresql://localhost/app"


def test_telegram_ids_must_be_numeric_without_echoing_bad_value() -> None:
    settings = Settings(TELEGRAM_PRODUCTION_CHAT_ID="not-a-telegram-id")
    with pytest.raises(RuntimeError, match="must be a numeric Telegram ID") as error:
        _ = settings.production_chat_id
    assert "not-a-telegram-id" not in str(error.value)


def test_developer_ids_support_a_comma_separated_allowlist() -> None:
    settings = Settings(DEVELOPER_TELEGRAM_USER_IDS="123, -456")
    assert settings.developer_user_ids == {123, -456}


def test_default_openrouter_model_is_a_general_purpose_free_model() -> None:
    settings = Settings(_env_file=None)
    assert settings.openrouter_model == "google/gemma-4-31b-it:free"
