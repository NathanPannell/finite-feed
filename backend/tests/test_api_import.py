def test_api_module_imports_with_annotation_routes() -> None:
    from backend.app.main import app

    paths = {route.path for route in app.routes}
    assert "/api/annotations/next" in paths
    assert "/api/annotations" in paths
    assert "/api/annotations/stats" in paths
    assert "/api/channels/resolve" in paths
