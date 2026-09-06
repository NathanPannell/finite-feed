"""Opt-in native-auth smoke test for an exact Finite Feed Vercel preview."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4


class SmokeFailure(RuntimeError):
    pass


def validate_preview_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError as exc:
        raise SmokeFailure("Target must be an exact generated Finite Feed Vercel preview URL") from exc
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or port
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not re.fullmatch(r"finite-feed-[a-z0-9-]+\.vercel\.app", host)
        or host == "finite-feed-rho.vercel.app"
    ):
        raise SmokeFailure("Target must be an exact generated Finite Feed Vercel preview URL")
    return f"https://{host}"


def deployment_is_preview(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    target = payload.get("target")
    environment = payload.get("environment")
    if isinstance(environment, str) and environment.lower() != "preview":
        return False
    return (
        isinstance(target, str) and target.lower() == "preview"
    ) or (
        isinstance(environment, str) and environment.lower() == "preview"
    )


def curl_arguments(
    preview_url: str,
    path: str,
    method: str,
    cookie_jar: Path,
    body_file: Path,
    has_json: bool,
) -> list[str]:
    arguments = [
        "curl", path, "--deployment", preview_url, "--",
        "--silent", "--show-error", "--request", method,
        "--output", str(body_file), "--write-out", "%{http_code}",
        "--cookie", str(cookie_jar), "--cookie-jar", str(cookie_jar),
        "--header", f"Origin: {preview_url}",
    ]
    if has_json:
        arguments += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
    return arguments


class PreviewClient:
    def __init__(self, executable: str, preview_url: str, workdir: Path, temporary_dir: Path):
        self.executable = executable
        self.preview_url = preview_url
        self.workdir = workdir
        self.cookie_jar = temporary_dir / "cookies"
        self.body_file = temporary_dir / "response"

    def _run(self, arguments: list[str], input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.executable, *arguments],
            cwd=self.workdir,
            input=input_text,
            text=True,
            capture_output=True,
            check=False,
        )

    def require_preview_deployment(self) -> None:
        result = self._run(["inspect", self.preview_url, "--json"])
        if result.returncode != 0:
            raise SmokeFailure("Vercel preview inspection failed")
        try:
            payload = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as exc:
            raise SmokeFailure("Vercel preview inspection returned invalid metadata") from exc
        if not deployment_is_preview(payload):
            raise SmokeFailure("Vercel deployment metadata did not identify a preview target")

    def request(self, operation: str, path: str, method: str = "GET", payload: dict | None = None,
                expected: set[int] | None = None) -> object | None:
        input_text = json.dumps(payload, separators=(",", ":")) if payload is not None else None
        result = self._run(curl_arguments(
            self.preview_url, path, method, self.cookie_jar, self.body_file, payload is not None,
        ), input_text=input_text)
        match = re.search(r"([1-5][0-9]{2})\s*$", result.stdout or "")
        status = int(match.group(1)) if match else None
        if result.returncode != 0 or status not in (expected or {200}):
            raise SmokeFailure(f"{operation} failed" + (f" with HTTP {status}" if status else ""))
        if status == 204 or not self.body_file.exists() or self.body_file.stat().st_size == 0:
            return None
        try:
            return json.loads(self.body_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SmokeFailure(f"{operation} returned an invalid response") from exc


def require_state(value: object, step: str) -> dict:
    if not isinstance(value, dict) or value.get("current_step") != step:
        raise SmokeFailure(f"Onboarding did not advance to {step}")
    return value


def complete_synthetic_onboarding(client: PreviewClient) -> None:
    require_state(client.request("Initial onboarding read", "/api/personal/onboarding"), "question_1")
    answers = (
        (1, "technology_ai", "question_2"),
        (2, "practical_skills", "question_3"),
        (3, "detailed_rigorous", "open_response"),
    )
    for question, answer, next_step in answers:
        state = client.request(
            f"Onboarding question {question}", "/api/personal/onboarding/answers", "PUT",
            {"question": question, "answer": answer},
        )
        require_state(state, next_step)
    state = client.request(
        "Onboarding open response", "/api/personal/onboarding/open-response", "PUT",
        {"response": "I build dependable software and want practical, rigorous ideas without hype."},
    )
    require_state(state, "profile_review")

    # Deliberately exactly one provider-backed call. Failures remain persisted and
    # retryable, but this smoke run never spends a second model request.
    state = client.request("Onboarding profile synthesis", "/api/personal/onboarding/synthesize", "POST")
    profile_state = require_state(state, "profile_review")
    if not isinstance(profile_state.get("draft_profile"), str) or not profile_state["draft_profile"].strip():
        raise SmokeFailure("Onboarding synthesis did not return a preference profile")
    state = client.request(
        "Onboarding profile acceptance", "/api/personal/onboarding/profile", "PUT", {"action": "accept"},
    )
    require_state(state, "delivery")
    state = client.request(
        "Onboarding delivery preferences", "/api/personal/onboarding/delivery", "PUT",
        {"timezone": "UTC", "cadence_days": [1, 4], "delivery_hour": 9, "recommendation_count": 1},
    )
    delivery_state = require_state(state, "telegram")
    expected_delivery = {
        "timezone": "UTC", "cadence_days": [1, 4], "delivery_hour": 9, "recommendation_count": 1,
    }
    if delivery_state.get("delivery") != expected_delivery:
        raise SmokeFailure("Onboarding delivery preferences were not persisted")
    completed = client.request(
        "Onboarding Telegram skip", "/api/personal/onboarding/complete", "POST", {"telegram": "skipped"},
    )
    completed_state = require_state(completed, "completed")
    if completed_state.get("status") != "completed" or completed_state.get("delivery") != expected_delivery:
        raise SmokeFailure("Onboarding completion state was not persisted")

    account = client.request("Completed account read", "/api/personal/account")
    if not isinstance(account, dict) or account.get("onboarding_completed") is not True or account.get("delivery_paused") is not True:
        raise SmokeFailure("Dashboard-only onboarding did not complete with delivery paused")
    exported = client.request("Onboarding audit export", "/api/personal/account/export")
    if not isinstance(exported, dict):
        raise SmokeFailure("Onboarding audit export returned an invalid response")
    audits = exported.get("onboarding_audit_logs")
    expected_audits = [
        ("question_1", "answered"), ("question_2", "answered"), ("question_3", "answered"),
        ("open_response", "answered"), ("profile", "synthesized"), ("profile", "accepted"),
        ("delivery", "saved"), ("telegram", "skipped"), ("onboarding", "completed"),
    ]
    try:
        ordered_audits = sorted(audits, key=lambda entry: int(entry["sequence"])) if isinstance(audits, list) else []
    except (KeyError, TypeError, ValueError) as exc:
        raise SmokeFailure("Onboarding audit export contained invalid sequence data") from exc
    observed = [(entry.get("step"), entry.get("action")) for entry in ordered_audits]
    if observed != expected_audits:
        raise SmokeFailure("Onboarding audit export did not contain the complete ordered journey")
    sessions = exported.get("onboarding_sessions")
    if not isinstance(sessions, list) or len(sessions) != 1 or not sessions[0].get("completed_at"):
        raise SmokeFailure("Onboarding session was missing from the account export")


def smoke(preview_url: str, *, auth_only: bool = False) -> None:
    executable = shutil.which("vercel.cmd") if os.name == "nt" else shutil.which("vercel")
    executable = executable or shutil.which("vercel")
    if not executable:
        raise SmokeFailure("Vercel CLI is not installed")
    frontend = Path(__file__).resolve().parents[1] / "frontend"
    if not (frontend / ".vercel" / "project.json").is_file():
        raise SmokeFailure("frontend/.vercel must be linked to the Finite Feed project")

    email = f"preview-auth-smoke-{uuid4().hex}@example.invalid"
    password = f"{secrets.token_urlsafe(36)}aA7!"
    with tempfile.TemporaryDirectory(prefix="finite-feed-preview-auth-") as temp:
        os.chmod(temp, 0o700)
        client = PreviewClient(executable, preview_url, frontend, Path(temp))
        client.require_preview_deployment()
        client.request("Native sign-up", "/api/auth/sign-up/email", "POST", {
            "email": email, "password": password, "name": "Preview auth smoke",
        }, {200, 201})
        first = client.request("Authenticated account read", "/api/personal/account")
        if not isinstance(first, dict) or first.get("email") != email or not first.get("id"):
            raise SmokeFailure("Authenticated account read returned the wrong identity")
        first_id = first["id"]
        client.request("Native sign-out", "/api/auth/sign-out", "POST", {}, {200, 204})
        client.request("Signed-out session check", "/api/personal/account", expected={401})
        client.request("Native sign-in", "/api/auth/sign-in/email", "POST", {
            "email": email, "password": password,
        }, {200, 201})
        second = client.request("Restored account read", "/api/personal/account")
        if not isinstance(second, dict) or second.get("id") != first_id or second.get("email") != email:
            raise SmokeFailure("Native sign-in did not restore the same identity")
        if not auth_only:
            complete_synthetic_onboarding(client)
        client.request("Synthetic app-account cleanup", "/api/personal/account", "DELETE", {
            "confirmation": "DELETE",
        }, {204})
        client.request("Final native sign-out", "/api/auth/sign-out", "POST", {}, {200, 204})


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Smoke-test native auth on one exact Finite Feed preview")
    parser.add_argument("--preview-url", required=True)
    parser.add_argument(
        "--auth-only", action="store_true",
        help="Verify sign-up, session restoration and cleanup without running onboarding or calling the model",
    )
    return parser


def main() -> int:
    arguments = argument_parser().parse_args()
    try:
        smoke(validate_preview_url(arguments.preview_url), auth_only=arguments.auth_only)
    except SmokeFailure as exc:
        print(f"Preview native-auth smoke failed: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print("Preview native-auth smoke failed: unexpected local error", file=sys.stderr)
        return 1
    if arguments.auth_only:
        print("Preview native-auth smoke passed: auth, identity, session restoration, cleanup")
    else:
        print("Preview native-auth smoke passed: auth, identity, onboarding, audit export, delivery pause, cleanup")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
