import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
import httpx
from fastapi import HTTPException
from psycopg.rows import dict_row

from backend.app import onboarding
from backend.app.onboarding import (
    AnswerUpdate,
    CompletionUpdate,
    OpenResponseUpdate,
    OnboardingDeliveryUpdate,
    ProfileDecision,
    complete,
    get_onboarding,
    save_answer,
    save_delivery,
    save_open_response,
    save_profile,
    synthesize,
    fallback_preference_profile,
)
from backend.app.openrouter import OpenRouterClient
from backend.worker.main import scheduled_delivery_users


class Reply:
    def __init__(self, content, model="test/model"):
        self.content = content
        self.model = model

    def raise_for_status(self):
        pass

    def json(self):
        return {"model": self.model, "choices": [{"message": {"content": self.content}}]}


def test_preference_synthesis_uses_labels_and_requires_two_to_five_sentences(monkeypatch):
    client = OpenRouterClient("test", "test/model", "https://example.com", "https://example.com")
    requests = []
    monkeypatch.setattr(client.client, "post", lambda path, json: requests.append(json) or Reply(
        '{"profile":"I want practical AI ideas that I can apply at work. I prefer rigorous explanations and want to avoid hype."}'
    ))

    result = client.synthesize_preferences(
        {"1": "technology_ai", "2": "practical_skills", "3": "detailed_rigorous"},
        "I build software and dislike hype.",
        onboarding.QUESTIONS,
    )

    assert result.profile.startswith("I want practical AI ideas")
    prompt = requests[0]["messages"][1]["content"]
    assert "Technology & AI" in prompt
    assert "I build software and dislike hype." in prompt

    monkeypatch.setattr(client.client, "post", lambda *args, **kwargs: Reply('{"profile":"Only one sentence."}'))
    with pytest.raises(ValueError, match="2 to 5 sentence"):
        client.synthesize_preferences(
            {"1": "technology_ai", "2": "practical_skills", "3": "detailed_rigorous"},
            "Enough detail here.", onboarding.QUESTIONS,
        )
    monkeypatch.setattr(client.client, "post", lambda *args, **kwargs: Reply('{"profile":null}'))
    with pytest.raises(ValueError, match="2 to 5 sentence"):
        client.synthesize_preferences(
            {"1": "technology_ai", "2": "practical_skills", "3": "detailed_rigorous"},
            "Enough detail here.", onboarding.QUESTIONS,
        )


def test_fallback_profile_concatenates_every_input_without_rewriting():
    own_words = "Keep this wording exactly—even punctuation. Sentence two? Sentence three!"
    profile = fallback_preference_profile(
        {"1": "technology_ai", "2": "practical_skills", "3": "detailed_rigorous"},
        own_words,
    )
    assert profile == "Technology & AI; Practical skills; Detailed & rigorous.\n\n" + own_words


@pytest.mark.parametrize("failure", ["no_key", "quota", "http", "timeout", "malformed"])
def test_synthesis_failures_persist_and_accept_exact_input_fallback(monkeypatch, failure):
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for onboarding fallback integration")
    user_id = uuid4()
    answers = {"1": "technology_ai", "2": "practical_skills", "3": "detailed_rigorous"}
    own_words = "One. Two. Three. Four. Five. Six sentences remain intact."
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            conn.execute(
                "INSERT INTO app_users(id,display_name,auth_subject) VALUES (%s,'Fallback test',%s)",
                (user_id, f"fallback-{user_id}"),
            )
            conn.execute(
                "INSERT INTO onboarding_sessions(user_id,answers,open_response) VALUES (%s,%s,%s)",
                (user_id, psycopg.types.json.Jsonb(answers), own_words),
            )
            conn.commit()
            monkeypatch.setattr(onboarding, "get_settings", lambda: SimpleNamespace(
                openrouter_api_key="" if failure == "no_key" else "test",
                openrouter_model="test/model", openrouter_base_url="https://example.test",
                public_app_url="https://app.example.test",
                model_daily_request_limit=0 if failure == "quota" else 10,
            ))
            if failure != "quota":
                monkeypatch.setattr(onboarding, "reserve_request", lambda *args: conn.commit())

            def fail(*args):
                if failure == "http":
                    request = httpx.Request("POST", "https://example.test/chat/completions")
                    response = httpx.Response(503, request=request)
                    raise httpx.HTTPStatusError("failed", request=request, response=response)
                if failure == "timeout":
                    raise httpx.ReadTimeout("timed out")
                raise ValueError("malformed response")

            provider_calls = []
            def client(*args):
                provider_calls.append(args)
                return SimpleNamespace(synthesize_preferences=fail, close=lambda: None)
            monkeypatch.setattr(onboarding, "OpenRouterClient", client)
            state = synthesize(user_id, conn)
            expected = fallback_preference_profile(answers, own_words)
            assert state["draft_profile"] == expected
            assert save_profile(ProfileDecision(action="accept"), user_id, conn)["current_step"] == "delivery"
            stored = conn.execute(
                "SELECT draft_model FROM onboarding_sessions WHERE user_id=%s", (user_id,),
            ).fetchone()
            audit = conn.execute(
                "SELECT action,payload FROM onboarding_audit_logs WHERE user_id=%s AND action='synthesized' "
                "ORDER BY sequence DESC LIMIT 1",
                (user_id,),
            ).fetchone()
            assert stored["draft_model"] is None
            assert audit["action"] == "synthesized"
            assert audit["payload"]["fallback"] is True
            assert audit["payload"]["profile"] == expected
            assert audit["payload"]["fallback_reason"] == {
                "no_key": "missing_api_key", "quota": "request_budget_exhausted",
                "http": "HTTPStatusError", "timeout": "ReadTimeout", "malformed": "ValueError",
            }[failure]
            assert bool(provider_calls) is (failure not in {"no_key", "quota"})
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_onboarding_is_persisted_ordered_audited_and_completes(monkeypatch):
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for onboarding integration")
    user_id = uuid4()
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            conn.execute(
                "INSERT INTO app_users(id,display_name,auth_subject,email) VALUES (%s,'Onboarding test',%s,'test@example.test')",
                (user_id, f"test-{user_id}"),
            )
            conn.execute(
                "INSERT INTO preference_versions(id,user_id,version,preference_statement,rendered_markdown,source) "
                "VALUES (%s,%s,1,'Starter placeholder','Starter placeholder','onboarding')",
                (uuid4(), user_id),
            )
            conn.commit()

            initial = get_onboarding(user_id, conn)
            assert initial["status"] == "not_started"
            assert initial["current_step"] == "question_1"
            with pytest.raises(HTTPException) as profile_bypass:
                save_profile(ProfileDecision(
                    action="change", profile="I want practical ideas. I prefer careful explanations."
                ), user_id, conn)
            assert profile_bypass.value.status_code == 409
            conn.rollback()
            with pytest.raises(HTTPException) as completion_bypass:
                complete(CompletionUpdate(telegram="skipped"), user_id, conn)
            assert completion_bypass.value.status_code == 409
            conn.rollback()
            with pytest.raises(HTTPException) as out_of_order:
                save_answer(AnswerUpdate(question=2, answer="practical_skills"), user_id, conn)
            assert out_of_order.value.status_code == 409
            conn.rollback()

            save_answer(AnswerUpdate(question=1, answer="technology_ai"), user_id, conn)
            save_answer(AnswerUpdate(question=2, answer="practical_skills"), user_id, conn)
            state = save_answer(AnswerUpdate(question=3, answer="detailed_rigorous"), user_id, conn)
            assert state["current_step"] == "open_response"
            state = save_open_response(OpenResponseUpdate(response="I build software and want careful explanations without hype."), user_id, conn)
            assert state["current_step"] == "profile_review"

            monkeypatch.setattr(onboarding, "get_settings", lambda: SimpleNamespace(
                openrouter_api_key="test", openrouter_model="test/model",
                openrouter_base_url="https://example.test", public_app_url="https://app.example.test",
                model_daily_request_limit=10,
            ))
            monkeypatch.setattr(onboarding, "reserve_request", lambda *args: conn.commit())
            monkeypatch.setattr(onboarding, "OpenRouterClient", lambda *args: SimpleNamespace(
                synthesize_preferences=lambda *args: SimpleNamespace(
                    profile="I want practical technology ideas I can apply while building software. I prefer careful, rigorous explanations and want to avoid hype.",
                    model="test/model",
                ),
                close=lambda: None,
            ))
            state = synthesize(user_id, conn)
            assert state["draft_profile"].startswith("I want practical technology")
            state = save_profile(ProfileDecision(action="accept"), user_id, conn)
            assert state["current_step"] == "delivery"
            state = save_delivery(OnboardingDeliveryUpdate(
                timezone="America/New_York", cadence_days=[4, 1, 4], delivery_hour=8,
                recommendation_count=3,
            ), user_id, conn)
            assert state["delivery"]["cadence_days"] == [1, 4]
            assert state["current_step"] == "telegram"
            linked_chat = user_id.int % 1_000_000_000 + 5_000_000_000
            conn.execute("UPDATE app_users SET telegram_user_id=%s WHERE id=%s", (linked_chat, user_id))
            conn.commit()
            state = complete(CompletionUpdate(telegram="skipped"), user_id, conn)
            assert state["status"] == "completed"
            assert state["current_step"] == "completed"
            with pytest.raises(HTTPException) as restart_completed:
                save_answer(AnswerUpdate(question=1, answer="science_nature"), user_id, conn)
            assert restart_completed.value.status_code == 409
            conn.rollback()

            stored = conn.execute(
                "SELECT onboarding_completed_at,timezone,cadence_days,delivery_hour,recommendation_count "
                "FROM app_users WHERE id=%s", (user_id,),
            ).fetchone()
            assert stored["onboarding_completed_at"] is not None
            assert stored["cadence_days"] == [1, 4]
            assert stored["recommendation_count"] == 3
            assert conn.execute("SELECT delivery_paused FROM app_users WHERE id=%s", (user_id,)).fetchone()["delivery_paused"] is True
            assert user_id not in {row["id"] for row in scheduled_delivery_users(conn)}
            versions = conn.execute(
                "SELECT version,preference_statement FROM preference_versions WHERE user_id=%s ORDER BY version", (user_id,)
            ).fetchall()
            assert [row["version"] for row in versions] == [1, 2]
            audits = conn.execute(
                "SELECT step,action FROM onboarding_audit_logs WHERE user_id=%s ORDER BY sequence", (user_id,)
            ).fetchall()
            assert [(row["step"], row["action"]) for row in audits] == [
                ("question_1", "answered"), ("question_2", "answered"), ("question_3", "answered"),
                ("open_response", "answered"), ("profile", "synthesized"), ("profile", "accepted"),
                ("delivery", "saved"), ("telegram", "skipped"), ("onboarding", "completed"),
            ]
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_profile_decision_requires_changed_text():
    with pytest.raises(ValueError):
        ProfileDecision(action="change")


def test_configured_legacy_account_without_session_reports_complete():
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required")
    user_id = uuid4()
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            conn.execute(
                "INSERT INTO app_users(id,display_name,auth_subject,onboarding_completed_at) VALUES (%s,'Configured',%s,NOW())",
                (user_id, f"configured-{user_id}"),
            )
            conn.commit()
            state = get_onboarding(user_id, conn)
            assert state["status"] == "completed"
            assert state["current_step"] == "completed"
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_connected_completion_requires_link_and_enables_delivery():
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required")
    user_id = uuid4()
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            conn.execute(
                "INSERT INTO app_users(id,display_name,auth_subject,delivery_paused) VALUES (%s,'Connect',%s,TRUE)",
                (user_id, f"connect-{user_id}"),
            )
            conn.execute(
                "INSERT INTO onboarding_sessions(user_id,answers,open_response,draft_profile,synthesized_at,"
                "profile_accepted_at,delivery_saved_at) VALUES (%s,'{}','details','Two sentences. Are accepted.',NOW(),NOW(),NOW())",
                (user_id,),
            )
            conn.commit()
            with pytest.raises(HTTPException) as missing_link:
                complete(CompletionUpdate(telegram="connected"), user_id, conn)
            assert missing_link.value.status_code == 409
            conn.rollback()
            chat_id = user_id.int % 1_000_000_000 + 6_000_000_000
            conn.execute("UPDATE app_users SET telegram_user_id=%s WHERE id=%s", (chat_id, user_id))
            conn.commit()
            state = complete(CompletionUpdate(telegram="connected"), user_id, conn)
            assert state["status"] == "completed"
            account = conn.execute(
                "SELECT delivery_paused,onboarding_completed_at FROM app_users WHERE id=%s", (user_id,)
            ).fetchone()
            assert account["delivery_paused"] is False
            assert account["onboarding_completed_at"] is not None
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_synthesis_does_not_overwrite_answers_changed_during_model_call(monkeypatch):
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for onboarding concurrency test")
    user_id = uuid4()
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            conn.execute(
                "INSERT INTO app_users(id,display_name,auth_subject) VALUES (%s,'Race test',%s)",
                (user_id, f"race-{user_id}"),
            )
            conn.execute(
                "INSERT INTO onboarding_sessions(user_id,answers,open_response) VALUES (%s,%s,%s)",
                (user_id, psycopg.types.json.Jsonb({
                    "1": "technology_ai", "2": "practical_skills", "3": "detailed_rigorous"
                }), "Original details about my interests."),
            )
            conn.commit()
            monkeypatch.setattr(onboarding, "get_settings", lambda: SimpleNamespace(
                openrouter_api_key="test", openrouter_model="test/model",
                openrouter_base_url="https://example.test", public_app_url="https://app.example.test",
                model_daily_request_limit=10,
            ))
            monkeypatch.setattr(onboarding, "reserve_request", lambda *args: conn.commit())

            def change_during_call(*args):
                with psycopg.connect(url) as other:
                    other.execute(
                        "UPDATE onboarding_sessions SET open_response='Newer details win.',updated_at=NOW() WHERE user_id=%s",
                        (user_id,),
                    )
                    other.commit()
                return SimpleNamespace(
                    profile="I want useful technology ideas. I prefer careful explanations.",
                    model="test/model",
                )

            monkeypatch.setattr(onboarding, "OpenRouterClient", lambda *args: SimpleNamespace(
                synthesize_preferences=change_during_call, close=lambda: None,
            ))
            with pytest.raises(HTTPException) as stale:
                synthesize(user_id, conn)
            assert stale.value.status_code == 409
            conn.rollback()
            stored = conn.execute(
                "SELECT open_response,draft_profile FROM onboarding_sessions WHERE user_id=%s", (user_id,)
            ).fetchone()
            assert stored == {"open_response": "Newer details win.", "draft_profile": None}
        finally:
            conn.rollback()
            conn.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
            conn.commit()


def test_answer_rejects_values_not_supplied_by_server():
    with pytest.raises(ValueError):
        AnswerUpdate(question=1, answer="anything")


def test_open_response_rejects_whitespace_after_normalization():
    with pytest.raises(ValueError):
        OpenResponseUpdate(response="             ")


def test_onboarding_delivery_requires_explicit_timezone_and_hour():
    with pytest.raises(ValueError):
        OnboardingDeliveryUpdate(cadence_days=[1], recommendation_count=1)


def test_migration_completes_only_preconfigured_accounts():
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is required for onboarding migration test")
    schema = "onboarding_" + uuid4().hex
    migration = (
        Path(__file__).resolve().parents[2] / "database" / "migrations" / "0015_onboarding.sql"
    ).read_text(encoding="utf-8")
    configured, placeholder, missing = uuid4(), uuid4(), uuid4()
    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            conn.execute(f'CREATE SCHEMA "{schema}"')
            conn.execute(f'SET LOCAL search_path TO "{schema}"')
            conn.execute("CREATE TABLE app_users(id UUID PRIMARY KEY)")
            conn.execute(
                "CREATE TABLE preference_versions(id UUID PRIMARY KEY,user_id UUID REFERENCES app_users(id),"
                "version INTEGER NOT NULL,preference_statement TEXT NOT NULL)"
            )
            conn.execute("INSERT INTO app_users(id) VALUES (%s),(%s),(%s)", (configured, placeholder, missing))
            conn.execute(
                "INSERT INTO preference_versions(id,user_id,version,preference_statement) VALUES "
                "(%s,%s,1,'Specific configured interests.'),"
                "(%s,%s,1,'Show me unusually useful ideas. I will add my interests and exclusions in settings.')",
                (uuid4(), configured, uuid4(), placeholder),
            )
            conn.execute(migration)
            rows = conn.execute("SELECT id,onboarding_completed_at FROM app_users").fetchall()
            by_id = {row["id"]: row["onboarding_completed_at"] for row in rows}
            assert by_id[configured] is not None
            assert by_id[placeholder] is None
            assert by_id[missing] is None
        finally:
            conn.rollback()
