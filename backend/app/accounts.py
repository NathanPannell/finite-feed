import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from psycopg import Connection

from backend.app.db import connection
from backend.app.recommendation_queue import invalidate_recommendation_queue
from backend.app.settings import get_settings
from backend.app.telegram import TelegramBot
from backend.app.user_auth import current_user

router = APIRouter(prefix="/api/account")
MANUAL_CODE_PATTERN = re.compile(r"\d{6}")
MANUAL_CODE_ATTEMPTS_PER_MINUTE = 5


@router.get("")
def account(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    return conn.execute("SELECT id,email,display_name,telegram_user_id IS NOT NULL AS telegram_connected,delivery_paused,delivery_status,delivery_error FROM app_users WHERE id=%s", (user_id,)).fetchone()


class PauseUpdate(BaseModel):
    paused: bool


@router.put("/delivery")
def pause(payload: PauseUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    conn.execute("UPDATE app_users SET delivery_paused=%s,updated_at=NOW() WHERE id=%s", (payload.paused,user_id))
    conn.commit()
    return account(user_id,conn)


@router.get("/preferences")
def history(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    return conn.execute("SELECT version,preference_statement,source,created_at FROM preference_versions WHERE user_id=%s ORDER BY version DESC", (user_id,)).fetchall()


@router.post("/telegram-link")
def telegram_link(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    settings = get_settings()
    token = settings.telegram_developer_bot_token if settings.is_preview else settings.telegram_production_bot_token
    if not token:
        raise HTTPException(503, "Telegram is not configured for this environment")
    try:
        bot = TelegramBot(token)
        if settings.is_preview:
            if not settings.telegram_webhook_secret or not settings.public_app_url.startswith("https://") or not settings.developer_user_ids:
                raise HTTPException(503, "Preview Telegram requires a secure webhook and an allowed tester.")
            # One Telegram bot has one webhook. An explicit preview Connect action
            # claims the developer bot; background workers never compete for it.
            bot.set_webhook(
                f"{settings.public_app_url.rstrip('/')}/telegram/webhook/developer",
                settings.telegram_webhook_secret,
            )
        username = bot._call("getMe", {})["result"]["username"]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Telegram is temporarily unavailable. Try again.") from exc
    raw = secrets.token_urlsafe(32)
    expiry = datetime.now(timezone.utc) + timedelta(minutes=10)
    conn.execute("SELECT id FROM app_users WHERE id=%s FOR UPDATE", (user_id,))
    conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s OR expires_at<NOW()", (user_id,))
    conn.execute(
        "INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at,kind) VALUES (%s,%s,%s,'deep_link')",
        (hashlib.sha256(raw.encode()).hexdigest(), user_id, expiry),
    )
    code = None
    for _ in range(10):
        candidate = f"{secrets.randbelow(1_000_000):06d}"
        inserted = conn.execute(
            """INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at,kind)
               VALUES (%s,%s,%s,'manual_code') ON CONFLICT DO NOTHING RETURNING token_hash""",
            (hashlib.sha256(candidate.encode()).hexdigest(), user_id, expiry),
        ).fetchone()
        if inserted:
            code = candidate
            break
    if code is None:
        conn.rollback()
        raise HTTPException(503, "Could not create a Telegram code. Try again.")
    conn.commit()
    return {"url": f"https://t.me/{username}?start={raw}", "code": code, "expires_at": expiry}


def consume_telegram_link(conn: Connection, raw: str, chat_id: int):
    kind = "manual_code" if MANUAL_CODE_PATTERN.fullmatch(raw) else "deep_link"
    digest = hashlib.sha256(raw.encode()).hexdigest()
    # Serialize both token consumption and chat ownership, including competing tokens.
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (chat_id,))
    if kind == "manual_code":
        attempt = conn.execute(
            """INSERT INTO telegram_link_attempts(chat_id) VALUES (%s)
               ON CONFLICT (chat_id) DO UPDATE SET
                 window_started_at = CASE
                   WHEN telegram_link_attempts.window_started_at <= NOW() - INTERVAL '1 minute' THEN NOW()
                   ELSE telegram_link_attempts.window_started_at END,
                 attempt_count = CASE
                   WHEN telegram_link_attempts.window_started_at <= NOW() - INTERVAL '1 minute' THEN 1
                   ELSE telegram_link_attempts.attempt_count + 1 END
               RETURNING attempt_count""",
            (chat_id,),
        ).fetchone()
        if not attempt or attempt["attempt_count"] > MANUAL_CODE_ATTEMPTS_PER_MINUTE:
            return None
    row = conn.execute(
        "SELECT user_id FROM telegram_link_tokens WHERE token_hash=%s AND kind=%s AND expires_at>NOW()",
        (digest, kind),
    ).fetchone()
    if not row:
        return None
    # Match account deletion/unlink/token creation order: account first, tokens
    # second. Never hold a token lock while waiting for its account row.
    account = conn.execute("SELECT id FROM app_users WHERE id=%s AND deleted_at IS NULL FOR UPDATE", (row["user_id"],)).fetchone()
    if not account:
        return None
    valid = conn.execute(
        "SELECT user_id FROM telegram_link_tokens WHERE token_hash=%s AND user_id=%s AND kind=%s AND expires_at>NOW() FOR UPDATE",
        (digest, row["user_id"], kind),
    ).fetchone()
    if not valid:
        return None
    owner = conn.execute("SELECT id FROM app_users WHERE telegram_user_id=%s", (chat_id,)).fetchone()
    if owner and owner["id"] != row["user_id"]:
        return None
    updated = conn.execute("UPDATE app_users SET telegram_user_id=%s,updated_at=NOW() WHERE id=%s AND deleted_at IS NULL AND (telegram_user_id IS NULL OR telegram_user_id=%s) RETURNING id", (chat_id,row["user_id"],chat_id)).fetchone()
    if not updated:
        return None
    conn.execute(
        """UPDATE telegram_preference_confirmations SET resolved_at=NOW(),accepted=FALSE
           WHERE user_id=%s AND resolved_at IS NULL""",
        (row["user_id"],),
    )
    invalidate_recommendation_queue(conn, row["user_id"])
    conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s", (row["user_id"],))
    conn.commit()
    return row["user_id"]


@router.delete("/telegram", status_code=204)
def unlink(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    conn.execute(
        "DELETE FROM telegram_link_attempts WHERE chat_id=(SELECT telegram_user_id FROM app_users WHERE id=%s)",
        (user_id,),
    )
    conn.execute("UPDATE app_users SET telegram_user_id=NULL,updated_at=NOW() WHERE id=%s", (user_id,))
    conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s", (user_id,))
    conn.execute(
        """UPDATE telegram_preference_confirmations SET resolved_at=NOW(),accepted=FALSE
           WHERE user_id=%s AND resolved_at IS NULL""",
        (user_id,),
    )
    conn.commit()
    return Response(status_code=204)


@router.get("/export")
def export(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    result = {"account": conn.execute("SELECT id,email,display_name,timezone,cadence_days,delivery_hour,recommendation_count,telegram_user_id,delivery_paused,created_at FROM app_users WHERE id=%s", (user_id,)).fetchone()}
    for table in (
        "preference_versions", "recommendations", "interaction_events",
        "user_channel_follows", "telegram_preference_confirmations",
    ):
        result[table] = conn.execute(f"SELECT * FROM {table} WHERE user_id=%s", (user_id,)).fetchall()
    return result


class DeleteAccount(BaseModel):
    confirmation: str


@router.delete("", status_code=204)
def delete_account(payload: DeleteAccount, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    if payload.confirmation != "DELETE":
        raise HTTPException(400, "Type DELETE to confirm account deletion")
    conn.execute("SELECT id FROM app_users WHERE id=%s FOR UPDATE", (user_id,))
    conn.execute(
        "DELETE FROM telegram_link_attempts WHERE chat_id=(SELECT telegram_user_id FROM app_users WHERE id=%s)",
        (user_id,),
    )
    for table in ("telegram_link_tokens", "telegram_preference_confirmations", "interaction_events", "recommendations", "preference_versions", "user_channel_follows"):
        conn.execute(f"DELETE FROM {table} WHERE user_id=%s", (user_id,))
    # Keep only an identity tombstone and canonical ingestion ownership. A still
    # valid provider session must not silently recreate a deleted app account.
    conn.execute("UPDATE app_users SET email=NULL,display_name='Deleted account',telegram_user_id=NULL,delivery_paused=TRUE,delivery_error=NULL,delivery_status=NULL,timezone='UTC',cadence_days=ARRAY[]::smallint[],delivery_hour=9,recommendation_count=1,deleted_at=NOW(),updated_at=NOW() WHERE id=%s", (user_id,))
    conn.commit()
    return Response(status_code=204)
