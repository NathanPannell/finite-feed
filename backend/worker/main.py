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
    lock_recommendation_for_delivery,
    mark_recommendation_delivered,
)
from backend.app.recommendation_queue import claim_queued_recommendation, refill_recommendation_queue
from backend.app.settings import get_settings
from backend.app.telegram import TelegramBot, cleanup_telegram_ephemera
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
    # A newly followed/library source should start on the next worker poll, not
    # inherit the last completed batch's six-hour delay. Per-channel cooldowns
    # and the persisted running lease still gate work inside ingestion.
    first_sync = conn.execute(
        "SELECT id FROM tracked_channels WHERE is_active AND last_sync_started_at IS NULL LIMIT 1"
    ).fetchone()
    if first_sync:
        return True
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


def scheduled_delivery_users(conn):
    return conn.execute(
        """SELECT id, telegram_user_id, timezone, cadence_days, delivery_hour,
                  recommendation_count, delivery_paused, onboarding_completed_at
           FROM app_users WHERE telegram_user_id IS NOT NULL AND NOT delivery_paused
             AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL"""
    ).fetchall()


def run_recommendation_queue_pass(pool: ConnectionPool) -> None:
    settings = get_settings()
    with pool.connection() as conn:
        cleanup_telegram_ephemera(conn)
        conn.commit()
    if not settings.openrouter_api_key:
        logger.info("Recommendation queue paused until OPENROUTER_API_KEY is configured")
        return
    with pool.connection() as conn:
        users = conn.execute(
            """SELECT id FROM app_users
               WHERE telegram_user_id IS NOT NULL AND deleted_at IS NULL
                 AND onboarding_completed_at IS NOT NULL"""
        ).fetchall()
    for user in users:
        try:
            with pool.connection() as conn:
                filled = refill_recommendation_queue(
                    conn, settings, user["id"], settings.delivery_retry_minutes,
                )
                if filled:
                    logger.info("Prepared %d Telegram recommendation(s) for user %s", filled, user["id"])
        except Exception as exc:
            logger.warning("Recommendation queue repair failed for user %s (%s)", user["id"], type(exc).__name__)


def run_recommendation_queue_loop(pool: ConnectionPool) -> None:
    while not stop_event.is_set():
        try:
            run_recommendation_queue_pass(pool)
        except Exception as exc:
            logger.warning("Recommendation queue pass failed (%s)", type(exc).__name__)
        stop_event.wait(get_settings().worker_poll_seconds)


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
        users = scheduled_delivery_users(conn)
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
                    queue_deferred = False
                    for _ in range(max(0, user["recommendation_count"] - count)):
                        active = conn.execute(
                            "SELECT delivery_paused, deleted_at, onboarding_completed_at FROM app_users WHERE id = %s",
                            (user["id"],),
                        ).fetchone()
                        if not active or active["delivery_paused"] or active["deleted_at"] or not active["onboarding_completed_at"]:
                            break
                        recommendation_id = claim_queued_recommendation(conn, user["id"], require_model=True)
                        if recommendation_id is None:
                            # Scheduled batches may exceed the two-item instant queue.
                            # Refill through the same durable lease path after releasing
                            # the account lock; interactive /recommend never does this.
                            conn.commit()
                            refill_recommendation_queue(
                                conn, settings, user["id"], settings.delivery_retry_minutes,
                            )
                            recommendation_id = claim_queued_recommendation(
                                conn, user["id"], require_model=True,
                            )
                            if recommendation_id is None:
                                queue_deferred = True
                                logger.info("Telegram recommendation queue is empty for user %s", user["id"])
                                break
                        # The queue claim never calls the model. Lock the current account to
                        # serialize this send against unlink and deletion.
                        current = conn.execute(
                            "SELECT telegram_user_id, delivery_paused, deleted_at, onboarding_completed_at FROM app_users WHERE id = %s FOR UPDATE",
                            (user["id"],),
                        ).fetchone()
                        if (not current or current["delivery_paused"] or current["deleted_at"]
                                or not current["onboarding_completed_at"] or current["telegram_user_id"] is None):
                            conn.rollback()
                            break
                        if lock_recommendation_for_delivery(conn, user["id"], recommendation_id):
                            bot.send_recommendation(conn, recommendation_id, current["telegram_user_id"], settings.public_app_url)
                            mark_recommendation_delivered(conn, user["id"], recommendation_id, scheduled=True)
                    conn.execute(
                        """UPDATE app_users
                           SET delivery_status = %s, delivery_error = NULL,
                               last_delivery_attempt_at = CASE WHEN %s THEN NULL ELSE last_delivery_attempt_at END
                           WHERE id = %s AND deleted_at IS NULL""",
                        ("waiting" if queue_deferred else "ready", queue_deferred, user["id"]),
                    )
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
    # Developer routing belongs to the latest explicit preview Connect action.
    # Periodic production recovery must not redirect that bot to another database.
    if settings.telegram_production_bot_token:
        TelegramBot(settings.telegram_production_bot_token).set_webhook(
            f"{settings.public_app_url.rstrip('/')}/telegram/webhook/production", settings.telegram_webhook_secret,
        )
        logger.info("Configured production Telegram webhook")


def main() -> None:
    settings = get_settings()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with ConnectionPool(
        settings.effective_database_url,
        kwargs={"row_factory": dict_row}, min_size=1, max_size=3,
    ) as pool:
        queue_thread = threading.Thread(
            target=run_recommendation_queue_loop,
            args=(pool,),
            name="recommendation-queue",
            daemon=True,
        )
        queue_thread.start()
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
        queue_thread.join(timeout=5)


if __name__ == "__main__":
    main()
