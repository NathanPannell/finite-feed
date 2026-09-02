import logging
import signal
import threading

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.app.settings import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
stop_event = threading.Event()


def request_stop(*_: object) -> None:
    stop_event.set()


def run_delivery_pass(pool: ConnectionPool) -> None:
    settings = get_settings()
    if settings.is_preview:
        logger.info("Preview environment: scheduled Telegram delivery is disabled")
        return
    if not settings.youtube_api_key or not settings.telegram_production_bot_token:
        logger.info("Delivery paused until YOUTUBE_API_KEY and TELEGRAM_PRODUCTION_BOT_TOKEN are configured")
        return
    with pool.connection() as conn:
        users = conn.execute(
            "SELECT id, timezone, cadence_days, delivery_hour FROM app_users WHERE telegram_user_id IS NOT NULL"
        ).fetchall()
    logger.info("Found %d configured delivery recipient(s)", len(users))
    # Ingestion, model reranking, and Telegram delivery attach here after keys are supplied.


def main() -> None:
    settings = get_settings()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with ConnectionPool(
        settings.effective_database_url,
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=2,
    ) as pool:
        while not stop_event.is_set():
            try:
                run_delivery_pass(pool)
            except Exception:
                logger.exception("Delivery pass failed")
            stop_event.wait(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
