from pathlib import Path

from backend.app.settings import PROJECT_ROOT

SOURCE_STAMP = PROJECT_ROOT / "backend" / ".railway-deployment-source"


def deployed_source_commit(configured_commit: str, source_stamp: Path = SOURCE_STAMP) -> str:
    if not source_stamp.is_file():
        return configured_commit
    stamped_commit = source_stamp.read_text(encoding="utf-8").strip().partition(":")[0]
    return stamped_commit or configured_commit
