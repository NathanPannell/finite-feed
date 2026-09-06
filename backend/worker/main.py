import logging
import signal
import threading
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.app.budgets import reserve_request
from backend.app.embedding_backfill import backfill_embeddings
from backend.app.embeddings import configured_embedder
from backend.app.ingestion import ingest_tracked_channels
from backend.app.recommendations import (
    get_or_create_pending_recommendation,
    lock_recommendation_for_delivery,
    mark_recommendation_delivered,
)
from backend.app.settings import get_settings
from backend.app.telegram import TelegramBot
from backend.app.youtube import YouTubeClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
stop_event = threading.Event()


def request_stop(*_: object) -> None:
    stop_event.set()


def ingestion_is_due(
    conn,
    interval_hours: int,
    retry_minutes: int = 30,
    now: datetime | None = None,
) -> bool:
    row = conn.execute(
        """
        SELECT status, started_at, completed_at
        FROM ingestion_runs
        ORDER BY started_at DESC
        LIMIT 1
        """
    ).fetchone()
    if not row:
        return True
    checked_at = now or datetime.now(UTC)
    last_attempt_at = row["completed_at"] or row["started_at"]
    cooldown = (
        timedelta(hours=interval_hours)
        if row["status"] == "completed"
        else timedelta(minutes=retry_minutes)
    )
    return last_attempt_at <= checked_at - cooldown


def run_ingestion_pass(pool: ConnectionPool) -> None:
    settings = get_settings()
    embedder = configured_embedder(settings)
    with pool.connection() as conn:
        backfill = backfill_embeddings(conn, embedder, batch_size=settings.embedding_batch_size)
        if backfill.attempted:
            logger.info(
                "Semantic backfill: %d batch(es), %d embedded, %d failed",
                backfill.batches, backfill.embedded, backfill.failed,
            )
        if not settings.youtube_api_key:
            logger.info("Ingestion paused until YOUTUBE_API_KEY is configured")
            return
        if not ingestion_is_due(conn, settings.ingestion_interval_hours, settings.ingestion_retry_minutes):
            return
        def reserve_youtube():
            with pool.connection() as budget_conn:
                reserve_request(budget_conn, "youtube", settings.youtube_daily_request_limit)
        youtube = YouTubeClient(settings.youtube_api_key, reserve_request=reserve_youtube)
        try:
            summary = ingest_tracked_channels(
                conn,
                youtube,
                settings.youtube_page_limit,
                embedder=embedder,
                sync_interval_hours=settings.ingestion_interval_hours,
                retry_minutes=settings.ingestion_retry_minutes,
            )
            logger.info(
                "Ingestion finished: %d channel(s), %d video(s), %d changed, %d failed",
                summary.channels_scanned, summary.videos_seen, summary.videos_changed,
                summary.channels_failed,
            )
        finally:
            youtube.close()


def delivery_is_due(user: dict, last_delivery: datetime | None, now: datetime) -> bool:
    if user.get("delivery_paused"):
        return False
    local_now = now.astimezone(ZoneInfo(user["timezone"]))
    sunday_based_weekday = (local_now.weekday() + 1) % 7
    if sunday_based_weekday not in user["cadence_days"] or local_now.hour < user["delivery_hour"]:
        return False
    return not last_delivery or last_delivery.astimezone(ZoneInfo(user["timezone"])).date() < local_now.date()


def claim_delivery_attempt(conn, user_id, now: datetime, retry_minutes: int) -> bool:
    claimed = conn.execute(
        """
        UPDATE app_users SET last_delivery_attempt_at = %s
        WHERE id = %s
          AND (last_delivery_attempt_at IS NULL OR last_delivery_attempt_at <= %s)
        RETURNING id
        """,
        (now, user_id, now - timedelta(minutes=retry_minutes)),
    ).fetchone()
    conn.commit()
    return bool(claimed)


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
    if not settings.delivery_enabled:
        logger.info("Delivery kill switch is active")
        return
    bot = TelegramBot(settings.telegram_production_bot_token)
    with pool.connection() as conn:
        users = conn.execute(
            """SELECT id, telegram_user_id, timezone, cadence_days, delivery_hour,
                      recommendation_count, delivery_paused
               FROM app_users WHERE telegram_user_id IS NOT NULL AND NOT delivery_paused
                 AND deleted_at IS NULL"""
        ).fetchall()
    for user in users:
        # A separate transaction/connection scope prevents one recipient poisoning the rest.
        try:
            with pool.connection() as conn:
                now = datetime.now(UTC)
                if not delivery_is_due(user, None, now):
                    continue
                if not claim_delivery_attempt(conn, user["id"], now, settings.delivery_retry_minutes):
                    continue
                try:
                    count = conn.execute(
                        """SELECT COUNT(*) AS count FROM recommendations WHERE user_id = %s
                        AND (delivered_at AT TIME ZONE %s)::date = (%s AT TIME ZONE %s)::date""",
                        (user["id"], user["timezone"], now, user["timezone"]),
                    ).fetchone()["count"]
                    for _ in range(max(0, user["recommendation_count"] - count)):
                        active = conn.execute("SELECT delivery_paused, deleted_at FROM app_users WHERE id = %s", (user["id"],)).fetchone()
                        if not active or active["delivery_paused"] or active["deleted_at"]:
                            break
                        recommendation_id = get_or_create_pending_recommendation(conn, settings, user["id"], require_model=True)
                        # Generation may commit and call the model. Lock the current account
                        # only after it returns, serializing this send against unlink/deletion.
                        current = conn.execute(
                            "SELECT telegram_user_id, delivery_paused, deleted_at FROM app_users WHERE id = %s FOR UPDATE",
                            (user["id"],),
                        ).fetchone()
                        if not current or current["delivery_paused"] or current["deleted_at"] or current["telegram_user_id"] is None:
                            conn.rollback()
                            break
                        if lock_recommendation_for_delivery(conn, user["id"], recommendation_id):
                            bot.send_recommendation(conn, recommendation_id, current["telegram_user_id"], settings.public_app_url)
                            mark_recommendation_delivered(conn, user["id"], recommendation_id, scheduled=True)
                    conn.execute("UPDATE app_users SET delivery_status = 'ready', delivery_error = NULL WHERE id = %s AND deleted_at IS NULL", (user["id"],))
                    conn.commit()
                except Exception as exc:
                    conn.rollback()
                    # Provider clients sanitize errors; store only class for unexpected exceptions.
                    message = str(exc)[:300] if isinstance(exc, ValueError) else type(exc).__name__
                    conn.execute("UPDATE app_users SET delivery_status = 'waiting', delivery_error = %s WHERE id = %s AND deleted_at IS NULL", (message, user["id"]))
                    conn.commit()
                    logger.warning("Delivery deferred for user %s (%s)", user["id"], type(exc).__name__)
        except Exception as exc:
            logger.warning("Recipient delivery failed (%s)", type(exc).__name__)


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
    with ConnectionPool(
        settings.effective_database_url,
        kwargs={"row_factory": dict_row}, min_size=1, max_size=3,
    ) as pool:
        webhook_retry_at = datetime.min.replace(tzinfo=UTC)
        while not stop_event.is_set():
            errors = []
            if datetime.now(UTC) >= webhook_retry_at:
                try:
                    configure_webhooks()
                    webhook_retry_at = datetime.now(UTC) + timedelta(hours=6)
                except Exception as exc:
                    errors.append(type(exc).__name__)
                    webhook_retry_at = datetime.now(UTC) + timedelta(minutes=15)
            for stage in (run_ingestion_pass, run_delivery_pass):
                try:
                    stage(pool)
                except Exception as exc:
                    errors.append(f"{stage.__name__}: {type(exc).__name__}")
                    logger.warning("Worker stage failed: %s (%s)", stage.__name__, type(exc).__name__)
            try:
                with pool.connection() as conn:
                    conn.execute(
                        """INSERT INTO worker_heartbeat (worker, status, error) VALUES ('pipeline', %s, %s)
                        ON CONFLICT (worker) DO UPDATE SET last_seen_at = NOW(), status = EXCLUDED.status, error = EXCLUDED.error""",
                        ("degraded" if errors else "healthy", "; ".join(errors) or None),
                    )
                    conn.commit()
            except Exception as exc:
                logger.warning("Worker heartbeat failed (%s)", type(exc).__name__)
            stop_event.wait(settings.worker_poll_seconds)


if __name__ == "__main__":
    main()
