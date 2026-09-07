import re
from typing import Literal
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.budgets import reserve_request
from backend.app.db import connection
from backend.app.openrouter import OpenRouterClient
from backend.app.schemas import DeliveryUpdate
from backend.app.settings import get_settings
from backend.app.user_auth import current_user

router = APIRouter(prefix="/api/onboarding")

QUESTIONS = (
    {
        "id": 1,
        "prompt": "What are you most interested in?",
        "options": [
            {"value": "technology_ai", "label": "Technology & AI"},
            {"value": "business_work", "label": "Business & work"},
            {"value": "science_nature", "label": "Science & nature"},
            {"value": "culture_society", "label": "Culture & society"},
            {"value": "mind_behavior", "label": "Mind & behavior"},
            {"value": "health_wellbeing", "label": "Health & wellbeing"},
        ],
    },
    {
        "id": 2,
        "prompt": "What do you want to get from your recommendations?",
        "options": [
            {"value": "practical_skills", "label": "Practical skills"},
            {"value": "fresh_perspectives", "label": "Fresh perspectives"},
            {"value": "deep_understanding", "label": "Deep understanding"},
            {"value": "inspiring_stories", "label": "Inspiring stories"},
        ],
    },
    {
        "id": 3,
        "prompt": "What style holds your attention?",
        "options": [
            {"value": "concise_focused", "label": "Concise & focused"},
            {"value": "detailed_rigorous", "label": "Detailed & rigorous"},
            {"value": "surprising_provocative", "label": "Surprising & provocative"},
            {"value": "accessible_conversational", "label": "Accessible & conversational"},
        ],
    },
)
QUESTION_OPTIONS = {q["id"]: {option["value"] for option in q["options"]} for q in QUESTIONS}


def fallback_preference_profile(answers: dict, open_response: str) -> str:
    """Preserve every onboarding input when model synthesis is unavailable."""
    labels = []
    for question in QUESTIONS:
        answer = answers[str(question["id"])]
        labels.append(next(
            option["label"] for option in question["options"]
            if option["value"] == answer
        ))
    return "; ".join(labels) + ".\n\n" + open_response


class AnswerUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: int = Field(ge=1, le=3)
    answer: str = Field(min_length=1, max_length=80)

    @model_validator(mode="after")
    def allowed_answer(self):
        if self.answer not in QUESTION_OPTIONS[self.question]:
            raise ValueError("Choose one of the supplied options")
        return self


class OpenResponseUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    response: str = Field(min_length=10, max_length=4000)

    @field_validator("response", mode="before")
    @classmethod
    def strip_response(cls, value):
        return value.strip() if isinstance(value, str) else value


class ProfileDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["accept", "change"]
    profile: str | None = Field(default=None, min_length=1, max_length=5000)

    @model_validator(mode="after")
    def validate_change(self):
        if self.action == "change" and not (self.profile and self.profile.strip()):
            raise ValueError("A changed profile is required")
        if self.profile is not None:
            self.profile = self.profile.strip()
        return self


class CompletionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    telegram: Literal["connected", "skipped"]


class OnboardingDeliveryUpdate(DeliveryUpdate):
    timezone: str = Field(min_length=1, max_length=80)
    delivery_hour: int = Field(ge=0, le=23)


def _session(conn: Connection, user_id: UUID, *, lock: bool = False):
    conn.execute(
        "INSERT INTO onboarding_sessions(user_id) VALUES (%s) ON CONFLICT (user_id) DO NOTHING",
        (user_id,),
    )
    suffix = " FOR UPDATE" if lock else ""
    return conn.execute(
        "SELECT * FROM onboarding_sessions WHERE user_id=%s" + suffix, (user_id,)
    ).fetchone()


def _audit(conn: Connection, user_id: UUID, step: str, action: str, payload: dict | None = None):
    conn.execute(
        "INSERT INTO onboarding_audit_logs(id,user_id,step,action,payload) VALUES (%s,%s,%s,%s,%s)",
        (uuid4(), user_id, step, action, Jsonb(payload or {})),
    )


def _ensure_incomplete(conn: Connection, user_id: UUID, row: dict):
    account = conn.execute("SELECT onboarding_completed_at FROM app_users WHERE id=%s", (user_id,)).fetchone()
    if row["completed_at"] or (account and account["onboarding_completed_at"]):
        raise HTTPException(409, "Onboarding is already complete")


def _current_step(row: dict) -> str:
    if row["completed_at"]:
        return "completed"
    answers = row["answers"] or {}
    for question in range(1, 4):
        if str(question) not in answers:
            return f"question_{question}"
    if not row["open_response"]:
        return "open_response"
    if not row["draft_profile"] or not row["profile_accepted_at"]:
        return "profile_review"
    if not row["delivery_saved_at"]:
        return "delivery"
    return "telegram"


def _state(conn: Connection, user_id: UUID, row: dict | None = None) -> dict:
    row = row or _session(conn, user_id)
    account = conn.execute(
        "SELECT timezone,cadence_days,delivery_hour,recommendation_count,"
        "telegram_user_id IS NOT NULL AS telegram_connected,onboarding_completed_at "
        "FROM app_users WHERE id=%s",
        (user_id,),
    ).fetchone()
    completed = bool(row["completed_at"] or account["onboarding_completed_at"])
    return {
        "status": "completed" if completed else ("not_started" if not row["answers"] else "in_progress"),
        "current_step": "completed" if completed else _current_step(row),
        "questions": QUESTIONS,
        "answers": row["answers"] or {},
        "open_response": row["open_response"],
        "draft_profile": row["draft_profile"],
        "delivery": {
            "timezone": account["timezone"],
            "cadence_days": account["cadence_days"],
            "delivery_hour": account["delivery_hour"],
            "recommendation_count": account["recommendation_count"],
        } if row["delivery_saved_at"] else None,
        "telegram_connected": account["telegram_connected"],
        "updated_at": row["updated_at"],
    }


@router.get("")
def get_onboarding(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id)
    conn.commit()
    return _state(conn, user_id, row)


@router.put("/answers")
def save_answer(payload: AnswerUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id, lock=True)
    _ensure_incomplete(conn, user_id, row)
    answers = dict(row["answers"] or {})
    required = {str(index) for index in range(1, payload.question)}
    if not required.issubset(answers):
        raise HTTPException(409, "Answer the onboarding questions in order")
    if answers.get(str(payload.question)) == payload.answer:
        conn.commit()
        return _state(conn, user_id, row)
    answers[str(payload.question)] = payload.answer
    for later in range(payload.question + 1, 4):
        answers.pop(str(later), None)
    conn.execute(
        "UPDATE onboarding_sessions SET answers=%s,open_response=NULL,draft_profile=NULL,draft_model=NULL,"
        "synthesized_at=NULL,profile_accepted_at=NULL,delivery_saved_at=NULL,telegram_choice=NULL,completed_at=NULL,updated_at=NOW() WHERE user_id=%s",
        (Jsonb(answers), user_id),
    )
    _audit(conn, user_id, f"question_{payload.question}", "answered", {"answer": payload.answer})
    conn.commit()
    return _state(conn, user_id)


@router.put("/open-response")
def save_open_response(payload: OpenResponseUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id, lock=True)
    _ensure_incomplete(conn, user_id, row)
    if not all(str(index) in (row["answers"] or {}) for index in range(1, 4)):
        raise HTTPException(409, "Complete the three questions first")
    if row["open_response"] == payload.response:
        conn.commit()
        return _state(conn, user_id, row)
    conn.execute(
        "UPDATE onboarding_sessions SET open_response=%s,draft_profile=NULL,draft_model=NULL,synthesized_at=NULL,"
        "profile_accepted_at=NULL,delivery_saved_at=NULL,telegram_choice=NULL,completed_at=NULL,updated_at=NOW() WHERE user_id=%s",
        (payload.response, user_id),
    )
    _audit(conn, user_id, "open_response", "answered", {"response": payload.response})
    conn.commit()
    return _state(conn, user_id)


@router.post("/synthesize")
def synthesize(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id)
    _ensure_incomplete(conn, user_id, row)
    answers = dict(row["answers"] or {})
    if not row["open_response"] or not all(str(index) in answers for index in range(1, 4)):
        raise HTTPException(409, "Complete your interest answers first")
    settings = get_settings()
    snapshot = (answers, row["open_response"], row["updated_at"])
    result = None
    fallback_reason = "missing_api_key" if not settings.openrouter_api_key else None
    if settings.openrouter_api_key:
        try:
            reserve_request(conn, "openrouter", settings.model_daily_request_limit)
        except ValueError:
            fallback_reason = "request_budget_exhausted"
        else:
            try:
                client = OpenRouterClient(
                    settings.openrouter_api_key, settings.openrouter_model,
                    settings.openrouter_base_url, settings.public_app_url,
                )
                try:
                    result = client.synthesize_preferences(answers, row["open_response"], QUESTIONS)
                finally:
                    client.close()
            except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
                fallback_reason = type(exc).__name__
    profile = result.profile if result else fallback_preference_profile(answers, row["open_response"])
    model = result.model if result else None
    account = conn.execute("SELECT deleted_at FROM app_users WHERE id=%s FOR UPDATE", (user_id,)).fetchone()
    if not account or account["deleted_at"]:
        conn.rollback()
        raise HTTPException(403, "This account has been deleted")
    locked = conn.execute("SELECT * FROM onboarding_sessions WHERE user_id=%s FOR UPDATE", (user_id,)).fetchone()
    if not locked:
        conn.rollback()
        raise HTTPException(409, "Your onboarding answers changed while the profile was being built. Try again.")
    if (dict(locked["answers"] or {}), locked["open_response"], locked["updated_at"]) != snapshot:
        conn.rollback()
        raise HTTPException(409, "Your answers changed while the profile was being built. Try again.")
    conn.execute(
        "UPDATE onboarding_sessions SET draft_profile=%s,draft_model=%s,synthesized_at=NOW(),profile_accepted_at=NULL,updated_at=NOW() WHERE user_id=%s",
        (profile, model, user_id),
    )
    _audit(conn, user_id, "profile", "synthesized", {
        "model": model, "profile": profile, "fallback": result is None,
        "fallback_reason": fallback_reason,
    })
    conn.commit()
    return _state(conn, user_id)


@router.put("/profile")
def save_profile(payload: ProfileDecision, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id, lock=True)
    _ensure_incomplete(conn, user_id, row)
    if not row["draft_profile"] or not row["synthesized_at"]:
        raise HTTPException(409, "Build a preference profile first")
    profile = payload.profile if payload.action == "change" else row["draft_profile"]
    if not profile:
        raise HTTPException(409, "Build a preference profile first")
    profile = profile.strip()
    fallback_draft = row["draft_model"] is None and profile == row["draft_profile"]
    if not fallback_draft and not 2 <= len(re.findall(r"[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$", profile)) <= 5:
        raise HTTPException(422, "The preference profile must be 2 to 5 sentences")
    if row["profile_accepted_at"]:
        if row["draft_profile"] == profile:
            conn.commit()
            return _state(conn, user_id, row)
        raise HTTPException(409, "The preference profile has already been accepted")
    current = conn.execute("SELECT COALESCE(MAX(version),0) AS version FROM preference_versions WHERE user_id=%s", (user_id,)).fetchone()
    version = current["version"] + 1
    rendered = f"# Current preferences\n\n{profile}\n\n## History\n\n- Version {version} accepted during onboarding."
    conn.execute(
        "INSERT INTO preference_versions(id,user_id,version,preference_statement,rendered_markdown,source,source_message) VALUES (%s,%s,%s,%s,%s,'onboarding',%s)",
        (uuid4(), user_id, version, profile, rendered, row["open_response"]),
    )
    conn.execute("UPDATE onboarding_sessions SET draft_profile=%s,profile_accepted_at=NOW(),updated_at=NOW() WHERE user_id=%s", (profile, user_id))
    _audit(conn, user_id, "profile", "changed_and_accepted" if payload.action == "change" else "accepted", {"version": version, "profile": profile})
    conn.commit()
    return _state(conn, user_id)


@router.put("/delivery")
def save_delivery(payload: OnboardingDeliveryUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id, lock=True)
    _ensure_incomplete(conn, user_id, row)
    if not row["profile_accepted_at"]:
        raise HTTPException(409, "Accept your preference profile first")
    conn.execute(
        "UPDATE app_users SET timezone=%s,cadence_days=%s,delivery_hour=%s,recommendation_count=%s,updated_at=NOW() WHERE id=%s",
        (payload.timezone, payload.cadence_days, payload.delivery_hour, payload.recommendation_count, user_id),
    )
    conn.execute("UPDATE onboarding_sessions SET delivery_saved_at=NOW(),updated_at=NOW() WHERE user_id=%s", (user_id,))
    _audit(conn, user_id, "delivery", "saved", payload.model_dump())
    conn.commit()
    return _state(conn, user_id)


@router.post("/complete")
def complete(payload: CompletionUpdate, user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    row = _session(conn, user_id, lock=True)
    if row["completed_at"]:
        conn.commit()
        return _state(conn, user_id, row)
    if not row["profile_accepted_at"] or not row["delivery_saved_at"]:
        raise HTTPException(409, "Finish the profile and delivery steps first")
    account = conn.execute("SELECT telegram_user_id FROM app_users WHERE id=%s", (user_id,)).fetchone()
    if payload.telegram == "connected" and not account["telegram_user_id"]:
        raise HTTPException(409, "Connect Telegram before choosing connected")
    conn.execute(
        "UPDATE onboarding_sessions SET telegram_choice=%s,completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE user_id=%s",
        (payload.telegram, user_id),
    )
    conn.execute(
        "UPDATE app_users SET onboarding_completed_at=COALESCE(onboarding_completed_at,NOW()),"
        "delivery_paused=%s,updated_at=NOW() WHERE id=%s",
        (payload.telegram == "skipped", user_id),
    )
    _audit(conn, user_id, "telegram", "connected" if payload.telegram == "connected" else "skipped")
    _audit(conn, user_id, "onboarding", "completed")
    conn.commit()
    return _state(conn, user_id)


@router.get("/audit")
def audit_log(user_id: UUID = Depends(current_user), conn: Connection = Depends(connection)):
    return conn.execute(
        "SELECT id,sequence,step,action,payload,created_at FROM onboarding_audit_logs WHERE user_id=%s ORDER BY sequence",
        (user_id,),
    ).fetchall()
