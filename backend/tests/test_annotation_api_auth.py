from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.auth import AuthenticatedAnnotator
from backend.app.db import connection


ANNOTATOR = AuthenticatedAnnotator(
    UUID("40000000-0000-4000-8000-000000000001"),
    "https://auth.example.test/app/auth",
    "google-user-1",
    "viewer@example.com",
    "Example Viewer",
    None,
)
PROFILE_ID = UUID("30000000-0000-4000-8000-000000000001")
VIDEO_ID = UUID("40000000-0000-4000-8000-000000000002")


def test_annotation_endpoints_require_bearer_auth(monkeypatch) -> None:
    main.app.dependency_overrides[connection] = lambda: object()
    try:
        client = TestClient(main.app)
        assert client.get("/api/annotations/next").status_code == 401
        assert client.get("/api/annotations/stats", headers={"Authorization": "Basic nope"}).status_code == 401
    finally:
        main.app.dependency_overrides.clear()


def test_verified_identity_reaches_all_annotation_endpoints(monkeypatch) -> None:
    observed: dict[str, object] = {}

    monkeypatch.setattr(main.token_verifier, "verify", lambda token: ANNOTATOR)
    monkeypatch.setattr(main, "next_annotation", lambda conn, annotator_id: observed.setdefault("next", annotator_id) and None)
    monkeypatch.setattr(main, "annotation_stats", lambda conn, annotator_id: observed.setdefault("stats", annotator_id) and {"completed": 3, "remaining": 7})

    def fake_record(conn, **values):
        observed["record"] = values["annotator"]
        return {
            "id": uuid4(),
            "profile_id": values["profile_id"],
            "video_id": values["video_id"],
            "annotator_id": values["annotator"].annotator_id,
            "annotator_kind": "google",
            "label": values["label"],
            "rationale": values["rationale"],
            "created_at": datetime.now(timezone.utc),
        }

    monkeypatch.setattr(main, "record_annotation", fake_record)
    main.app.dependency_overrides[connection] = lambda: object()
    try:
        client = TestClient(main.app)
        headers = {"Authorization": "Bearer signed-token"}
        assert client.get("/api/annotations/next", headers=headers).status_code == 200
        assert client.get("/api/annotations/stats", headers=headers).json() == {"completed": 3, "remaining": 7}
        response = client.post(
            "/api/annotations",
            headers=headers,
            json={
                "annotator_id": "50000000-0000-4000-8000-000000000008",
                "profile_id": str(PROFILE_ID),
                "video_id": str(VIDEO_ID),
                "label": "yes",
                "rationale": None,
            },
        )
        assert response.status_code == 201
        assert response.json()["annotator_id"] == str(ANNOTATOR.annotator_id)
        assert observed == {"next": ANNOTATOR.annotator_id, "stats": ANNOTATOR.annotator_id, "record": ANNOTATOR}
    finally:
        main.app.dependency_overrides.clear()
