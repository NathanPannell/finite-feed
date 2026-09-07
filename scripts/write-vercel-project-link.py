"""Create the runner-local Vercel project link required by preview smoke tests."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


class ProjectLinkError(ValueError):
    pass


def required_identifier(value: str, prefix: str, label: str) -> str:
    if not re.fullmatch(rf"{re.escape(prefix)}[A-Za-z0-9]+", value):
        raise ProjectLinkError(f"{label} must be a Vercel {label.lower()} identifier")
    return value


def write_project_link(frontend_dir: Path, org_id: str, project_id: str) -> Path:
    org_id = required_identifier(org_id, "team_", "organization ID")
    project_id = required_identifier(project_id, "prj_", "project ID")
    link_dir = frontend_dir / ".vercel"
    link_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = link_dir / "project.json"
    temporary = link_dir / ".project.json.tmp"
    temporary.write_text(json.dumps({"orgId": org_id, "projectId": project_id}) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(target)
    return target


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Write one local Vercel project link")
    parser.add_argument("--frontend-dir", required=True, type=Path)
    parser.add_argument("--org-id", required=True)
    parser.add_argument("--project-id", required=True)
    return parser


def main() -> int:
    arguments = argument_parser().parse_args()
    try:
        write_project_link(arguments.frontend_dir, arguments.org_id, arguments.project_id)
    except ProjectLinkError as exc:
        parser = argument_parser()
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
