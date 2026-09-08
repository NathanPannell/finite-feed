from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.admin import router as admin_router
from backend.app.admin_auth import require_admin
from backend.app.db import connection
from backend.app.feature_flags import MATCH_LAB_HOMEPAGE_VISIBLE, router as feature_router


class Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FeatureFlagConnection:
    def __init__(self, enabled=None):
        self.enabled = enabled
        self.audit_params = None
        self.committed = False

    def execute(self, query, params=None):
        sql = str(query)
        if sql.startswith("SELECT enabled"):
            if self.enabled is None:
                return Result()
            return Result({"enabled": self.enabled, "updated_at": None, "updated_by": None})
        if "INSERT INTO app_feature_flags" in sql:
            self.enabled = params[1]
            return Result({
                "enabled": self.enabled,
                "updated_at": datetime(2026, 9, 6, tzinfo=timezone.utc),
                "updated_by": params[2],
            })
        if "INSERT INTO admin_audit_events" in sql:
            self.audit_params = params
            return Result()
        raise AssertionError(sql)

    def commit(self):
        self.committed = True


def client_for(conn: FeatureFlagConnection, *, admin=False) -> TestClient:
    app = FastAPI()
    app.include_router(admin_router if admin else feature_router)
    app.dependency_overrides[connection] = lambda: conn
    if admin:
        app.dependency_overrides[require_admin] = lambda: {"sub": "verified-admin"}
    return TestClient(app)


def test_public_flag_defaults_enabled_and_reads_disabled_value() -> None:
    missing = client_for(FeatureFlagConnection())
    missing_response = missing.get("/api/features")
    assert missing_response.json() == {MATCH_LAB_HOMEPAGE_VISIBLE: True}
    assert missing_response.headers["cache-control"] == "no-store"

    disabled = client_for(FeatureFlagConnection(False))
    assert disabled.get("/api/features").json() == {MATCH_LAB_HOMEPAGE_VISIBLE: False}


def test_admin_can_toggle_flag_and_change_is_audited() -> None:
    conn = FeatureFlagConnection(True)
    client = client_for(conn, admin=True)

    response = client.patch(
        "/api/admin/feature-flags/match-lab-homepage",
        json={"enabled": False},
    )

    assert response.status_code == 200
    assert response.json()["enabled"] is False
    assert conn.enabled is False
    assert conn.committed is True
    assert conn.audit_params[2] == "verified-admin"
    assert conn.audit_params[3].obj == {"enabled": True}
    assert conn.audit_params[4].obj == {"enabled": False}


def test_admin_flag_update_rejects_unexpected_fields() -> None:
    response = client_for(FeatureFlagConnection(True), admin=True).patch(
        "/api/admin/feature-flags/match-lab-homepage",
        json={"enabled": False, "key": "another_flag"},
    )
    assert response.status_code == 422
    assert client_for(FeatureFlagConnection(True), admin=True).patch(
        "/api/admin/feature-flags/match-lab-homepage",
        json={"enabled": "false"},
    ).status_code == 422


def test_admin_flag_routes_require_authentication() -> None:
    app = FastAPI()
    app.include_router(admin_router)
    app.dependency_overrides[connection] = lambda: FeatureFlagConnection(True)
    client = TestClient(app)

    assert client.get("/api/admin/feature-flags/match-lab-homepage").status_code == 401
    assert client.patch(
        "/api/admin/feature-flags/match-lab-homepage",
        json={"enabled": False},
    ).status_code == 401


def test_feature_flag_migration_preserves_current_homepage_visibility() -> None:
    sql = (Path(__file__).parents[2] / "database/migrations/0018_feature_flags.sql").read_text()
    assert "'match_lab_homepage_visible', TRUE" in sql
