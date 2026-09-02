import logging
import signal
import threading
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from backend.app.ingestion import ingest_tracked_channels
from backend.app.recommendations import generate_recommendation
from backend.app.settings import get_settings
from backend.app.telegram import TelegramBot
from backend.app.youtube import YouTubeClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
stop_event = threading.Event()


def request_stop(*_: object) -> None:
    stop_event.set()


def ingestion_is_due(conn, interval_hours: int) -> bool:
    row = conn.execute(
        "SELECT MAX(completed_at) AS completed_at FROM ingestion_runs WHERE status = 'completed'"
    ).fetchone()
    return not row["completed_at"] or row["completed_at"] <= datetime.now(UTC) - timedelta(hours=interval_hours)


def run_ingestion_pass(pool: ConnectionPool) -> None:
    settings = get_settings()
    if not settings.youtube_api_key:
        logger.info("Ingestion paused until YOUTUBE_API_KEY is configured")
        return
    with pool.connection() as conn:
        if not ingestion_is_due(conn, settings.ingestion_interval_hours):
            return
        youtube = YouTubeClient(settings.youtube_api_key)
        try:
            summary = ingest_tracked_channels(conn, youtube, settings.youtube_page_limit)
            logger.info(
                "Ingestion completed: %d channel(s), %d video(s), %d changed",
                summary.channels_scanned, summary.videos_seen, summary.videos_changed,
            )
        finally:
            youtube.close()


def delivery_is_due(user: dict, last_delivery: datetime | None, now: datetime) -> bool:
    local_now = now.astimezone(ZoneInfo(user["timezone"]))
    sunday_based_weekday = (local_now.weekday() + 1) % 7
    if sunday_based_weekday not in user["cadence_days"] or local_now.hour < user["delivery_hour"]:
        return False
    return not last_delivery or last_delivery.astimezone(ZoneInfo(user["timezone"])).date() < local_now.date()


def run_delivery_pass(pool: ConnectionPool) -> None:
    settings = get_settings()
    if settings.is_preview:
        logger.info("Preview environment: scheduled Telegram delivery is disabled")
        return
    missing = [name for name, value in (
        ("OPENROUTER_API_KEY", settings.openrouter_api_key),
        ("TELEGRAM_PRODUCTION_BOT_TOKEN", settings.telegram_production_bot_token),
    ) if not value]
    if missing:
        logger.info("Delivery paused until %s is configured", " and ".join(missing))
        return
    bot = TelegramBot(settings.telegram_production_bot_token)
    with pool.connection() as conn:
        if settings.production_chat_id is not None:
            conn.execute(
                "UPDATE app_users SET telegram_user_id = %s WHERE id = '00000000-0000-0000-0000-000000000001' AND telegram_user_id IS NULL",
                (settings.production_chat_id,),
            )
            conn.commit()
        users = conn.execute(
            """
            SELECT u.id, u.telegram_user_id, u.timezone, u.cadence_days, u.delivery_hour,
                   MAX(r.delivered_at) AS last_delivery
            FROM app_users u LEFT JOIN recommendations r ON r.user_id = u.id
            WHERE u.telegram_user_id IS NOT NULL
            GROUP BY u.id
            """
        ).fetchall()
        now = datetime.now(UTC)
        for user in users:
            if not delivery_is_due(user, user["last_delivery"], now):
                continue
            recommendation_id = generate_recommendation(conn, settings, user["id"], require_model=True)
            bot.send_recommendation(conn, recommendation_id, user["telegram_user_id"], settings.public_app_url)
            conn.execute("UPDATE recommendations SET delivered_at = NOW() WHERE id = %s", (recommendation_id,))
            conn.execute(
                "INSERT INTO interaction_events (id, user_id, recommendation_id, event_type, source, metadata) VALUES (gen_random_uuid(), %s, %s, 'delivery', 'telegram', %s)",
                (user["id"], recommendation_id, Jsonb({"scheduled": True})),
            )
            conn.commit()
            logger.info("Delivered recommendation %s", recommendation_id)


def configure_webhooks() -> None:
    settings = get_settings()
    if settings.is_preview or not settings.telegram_webhook_secret or not settings.public_app_url.startswith("https://"):
        return
    for kind, token in (
        ("production", settings.telegram_production_bot_token),
        ("developer", settings.telegram_developer_bot_token),
    ):
        if token:
            TelegramBot(token).set_webhook(
                f"{settings.public_app_url.rstrip('/')}/telegram/webhook/{kind}", settings.telegram_webhook_secret,
            )
            logger.info("Configured %s Telegram webhook", kind)


def main() -> None:
    settings = get_settings()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        configure_webhooks()
    except Exception:
        logger.exception("Telegram webhook setup failed; worker will retry on restart")
    with ConnectionPool(
        settings.effective_database_url,
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=2,
    ) as pool:
        while not stop_event.is_set():
            try:
                run_ingestion_pass(pool)
                run_delivery_pass(pool)
            except Exception:
                logger.exception("Worker pass failed")
            stop_event.wait(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
