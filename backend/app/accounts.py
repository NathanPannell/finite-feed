import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from psycopg import Connection

from backend.app.db import connection
from backend.app.settings import get_settings
from backend.app.telegram import TelegramBot
from backend.app.user_auth import current_user

router = APIRouter(prefix="/api/account")


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
        username = TelegramBot(token)._call("getMe", {})["result"]["username"]
    except Exception as exc:
        raise HTTPException(503, "Telegram is temporarily unavailable. Try again.") from exc
    raw = secrets.token_urlsafe(32)
    expiry = datetime.now(timezone.utc) + timedelta(minutes=10)
    conn.execute("SELECT id FROM app_users WHERE id=%s FOR UPDATE", (user_id,))
    conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s OR expires_at<NOW()", (user_id,))
    conn.execute("INSERT INTO telegram_link_tokens(token_hash,user_id,expires_at) VALUES (%s,%s,%s)", (hashlib.sha256(raw.encode()).hexdigest(),user_id,expiry))
    conn.commit()
    return {"url": f"https://t.me/{username}?start={raw}", "expires_at": expiry}


def consume_telegram_link(conn: Connection, raw: str, chat_id: int):
    digest = hashlib.sha256(raw.encode()).hexdigest()
    # Serialize both token consumption and chat ownership, including competing tokens.
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (chat_id,))
    row = conn.execute("SELECT user_id FROM telegram_link_tokens WHERE token_hash=%s AND expires_at>NOW() FOR UPDATE", (digest,)).fetchone()
    if not row:
        return None
    owner = conn.execute("SELECT id FROM app_users WHERE telegram_user_id=%s", (chat_id,)).fetchone()
    if owner and owner["id"] != row["user_id"]:
        return None
    updated = conn.execute("UPDATE app_users SET telegram_user_id=%s,updated_at=NOW() WHERE id=%s AND deleted_at IS NULL AND (telegram_user_id IS NULL OR telegram_user_id=%s) RETURNING id", (chat_id,row["user_id"],chat_id)).fetchone()
    if not updated:
        return None
    conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s", (row["user_id"],))
    conn.commit()
    return row["user_id"]


@router.delete("/telegram", status_code=204)
def unlink(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    conn.execute("UPDATE app_users SET telegram_user_id=NULL,updated_at=NOW() WHERE id=%s", (user_id,))
    conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=%s", (user_id,))
    conn.commit()
    return Response(status_code=204)


@router.get("/export")
def export(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    result = {"account": conn.execute("SELECT id,email,display_name,timezone,cadence_days,delivery_hour,recommendation_count,telegram_user_id,delivery_paused,created_at FROM app_users WHERE id=%s", (user_id,)).fetchone()}
    for table in ("preference_versions", "recommendations", "interaction_events", "user_channel_follows"):
        result[table] = conn.execute(f"SELECT * FROM {table} WHERE user_id=%s", (user_id,)).fetchall()
    return result


class DeleteAccount(BaseModel):
    confirmation: str


@router.delete("", status_code=204)
def delete_account(payload: DeleteAccount, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    if payload.confirmation != "DELETE":
        raise HTTPException(400, "Type DELETE to confirm account deletion")
    conn.execute("SELECT id FROM app_users WHERE id=%s FOR UPDATE", (user_id,))
    for table in ("telegram_link_tokens", "interaction_events", "recommendations", "preference_versions", "user_channel_follows"):
        conn.execute(f"DELETE FROM {table} WHERE user_id=%s", (user_id,))
    # Keep only an identity tombstone and canonical ingestion ownership. A still
    # valid provider session must not silently recreate a deleted app account.
    conn.execute("UPDATE app_users SET email=NULL,display_name='Deleted account',telegram_user_id=NULL,delivery_paused=TRUE,delivery_error=NULL,delivery_status=NULL,timezone='UTC',cadence_days=ARRAY[]::smallint[],delivery_hour=9,recommendation_count=1,deleted_at=NOW(),updated_at=NOW() WHERE id=%s", (user_id,))
    conn.commit()
    return Response(status_code=204)
