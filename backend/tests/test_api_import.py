def test_api_module_imports_with_annotation_routes() -> None:
    from backend.app.main import app

    paths = set(app.openapi()["paths"])
    assert "/api/annotations/next" in paths
    assert "/api/annotations" in paths
    assert "/api/annotations/stats" in paths
    assert "/api/channels/resolve" in paths
    assert "/api/onboarding" in paths
    assert "/api/onboarding/synthesize" in paths
