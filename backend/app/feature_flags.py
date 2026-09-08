from fastapi import APIRouter, Depends, Response
from psycopg import Connection

from backend.app.db import connection

MATCH_LAB_HOMEPAGE_VISIBLE = "match_lab_homepage_visible"

router = APIRouter(prefix="/api/features", tags=["features"])


def is_feature_enabled(conn: Connection, key: str, *, default: bool = True) -> bool:
    row = conn.execute(
        "SELECT enabled FROM app_feature_flags WHERE key = %s",
        (key,),
    ).fetchone()
    return bool(row["enabled"]) if row else default


@router.get("")
def public_features(response: Response, conn: Connection = Depends(connection)) -> dict[str, bool]:
    response.headers["Cache-Control"] = "no-store"
    return {
        MATCH_LAB_HOMEPAGE_VISIBLE: is_feature_enabled(
            conn,
            MATCH_LAB_HOMEPAGE_VISIBLE,
        )
    }
