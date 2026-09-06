import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("smoke-preview-native-auth.py")
SPEC = importlib.util.spec_from_file_location("preview_auth_smoke", SCRIPT)
smoke = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(smoke)


def test_target_validation_accepts_generated_preview_and_rejects_production_or_lookalikes():
    assert smoke.validate_preview_url(
        "https://finite-feed-git-preview-nathan-projects.vercel.app/"
    ) == "https://finite-feed-git-preview-nathan-projects.vercel.app"
    for unsafe in (
        "https://finite-feed-rho.vercel.app",
        "https://finite-feed.example.com",
        "http://finite-feed-test.vercel.app",
        "https://finite-feed-test.vercel.app/path",
        "https://attacker.example/?next=finite-feed-test.vercel.app",
    ):
        with pytest.raises(smoke.SmokeFailure):
            smoke.validate_preview_url(unsafe)


def test_deployment_metadata_must_explicitly_identify_preview():
    assert smoke.deployment_is_preview({"target": "preview"})
    assert smoke.deployment_is_preview({"environment": "Preview"})
    assert not smoke.deployment_is_preview({"target": None})
    assert not smoke.deployment_is_preview({"target": "production"})
    assert not smoke.deployment_is_preview({"target": None, "environment": "Production"})
    assert not smoke.deployment_is_preview({})


def test_request_arguments_never_contain_json_credentials(tmp_path):
    password = "unique-secret-password"
    arguments = smoke.curl_arguments(
        "https://finite-feed-test.vercel.app", "/api/auth/sign-in/email", "POST",
        tmp_path / "cookies", tmp_path / "body", True,
    )
    rendered = " ".join(arguments)
    assert password not in rendered
    assert "@-" in arguments
    assert "--data-binary" in arguments
    assert "Origin: https://finite-feed-test.vercel.app" in arguments


def test_failures_report_only_operation_and_status(tmp_path):
    class FakeClient(smoke.PreviewClient):
        def _run(self, arguments, input_text=None):
            return smoke.subprocess.CompletedProcess(arguments, 0, "401", "provider body with secret")

    client = FakeClient("vercel", "https://finite-feed-test.vercel.app", tmp_path, tmp_path)
    with pytest.raises(smoke.SmokeFailure) as raised:
        client.request("Native sign-in", "/api/auth/sign-in/email", "POST", {
            "email": "secret@example.invalid", "password": "hidden",
        })
    assert str(raised.value) == "Native sign-in failed with HTTP 401"
    assert "secret@example.invalid" not in str(raised.value)
    assert "provider body" not in str(raised.value)


def test_full_onboarding_uses_one_synthesis_and_verifies_export():
    delivery = {"timezone": "UTC", "cadence_days": [1, 4], "delivery_hour": 9, "recommendation_count": 1}
    expected_audits = [
        ("question_1", "answered"), ("question_2", "answered"), ("question_3", "answered"),
        ("open_response", "answered"), ("profile", "synthesized"), ("profile", "accepted"),
        ("delivery", "saved"), ("telegram", "skipped"), ("onboarding", "completed"),
    ]

    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, operation, path, method="GET", payload=None, expected=None):
            self.calls.append((path, method, payload))
            if path == "/api/personal/onboarding" and method == "GET":
                return {"current_step": "question_1", "status": "not_started"}
            if path.endswith("/answers"):
                return {"current_step": {1: "question_2", 2: "question_3", 3: "open_response"}[payload["question"]]}
            if path.endswith("/open-response"):
                return {"current_step": "profile_review"}
            if path.endswith("/synthesize"):
                return {"current_step": "profile_review", "draft_profile": "I want practical ideas. I prefer rigor."}
            if path.endswith("/profile"):
                return {"current_step": "delivery"}
            if path.endswith("/delivery"):
                return {"current_step": "telegram", "delivery": delivery}
            if path.endswith("/complete"):
                return {"current_step": "completed", "status": "completed", "delivery": delivery}
            if path == "/api/personal/account":
                return {"onboarding_completed": True, "delivery_paused": True}
            if path == "/api/personal/account/export":
                return {
                    "onboarding_audit_logs": [
                        {"sequence": index, "step": step, "action": action}
                        for index, (step, action) in reversed(list(enumerate(expected_audits, start=1)))
                    ],
                    "onboarding_sessions": [{"completed_at": "2026-09-06T00:00:00Z"}],
                }
            raise AssertionError((path, method, payload))

    client = FakeClient()
    smoke.complete_synthetic_onboarding(client)
    synthesis_calls = [call for call in client.calls if call[0].endswith("/synthesize")]
    assert len(synthesis_calls) == 1
    assert next(call for call in client.calls if call[0].endswith("/complete"))[2] == {"telegram": "skipped"}
    assert any(call[0] == "/api/personal/account/export" for call in client.calls)
