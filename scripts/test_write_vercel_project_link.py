import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("write-vercel-project-link.py")
SPEC = importlib.util.spec_from_file_location("write_vercel_project_link", SCRIPT)
link = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(link)


def test_writes_the_exact_runner_local_vercel_project_link(tmp_path):
    target = link.write_project_link(tmp_path / "frontend", "team_abc123", "prj_def456")

    assert target == tmp_path / "frontend" / ".vercel" / "project.json"
    assert json.loads(target.read_text(encoding="utf-8")) == {
        "orgId": "team_abc123",
        "projectId": "prj_def456",
    }


@pytest.mark.parametrize("org_id,project_id", [
    ("wrong_abc", "prj_def"),
    ("team_abc", "wrong_def"),
    ("team_abc!", "prj_def"),
])
def test_rejects_invalid_vercel_identifiers(tmp_path, org_id, project_id):
    with pytest.raises(link.ProjectLinkError):
        link.write_project_link(tmp_path / "frontend", org_id, project_id)
