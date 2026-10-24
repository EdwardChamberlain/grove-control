"""Keep the frontend's copy of the backend route table in sync.

``frontend/src/__tests__/api/backend-routes.json`` lists every ``METHOD /path``
the API serves. The frontend contract test
(``frontend/src/__tests__/api/clientContract.test.ts``) checks that each
``api`` client method calls one of these routes, so a renamed or removed
endpoint fails CI on the frontend side instead of 404ing in production.

This test fails when the snapshot drifts from the app. Regenerate it with:

    cd backend && UPDATE_ROUTE_SNAPSHOT=1 ../venv/bin/python -m pytest tests/unit/test_api_route_snapshot.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

from backend.app.main import app

SNAPSHOT = Path(__file__).resolve().parents[3] / "frontend" / "src" / "__tests__" / "api" / "backend-routes.json"


def _api_routes() -> list[str]:
    routes: set[str] = set()
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/v1/"):
            for method in route.methods - {"HEAD", "OPTIONS"}:
                routes.add(f"{method} {route.path}")
    return sorted(routes)


def test_frontend_route_snapshot_matches_app():
    current = _api_routes()

    if os.environ.get("UPDATE_ROUTE_SNAPSHOT"):
        SNAPSHOT.write_text(json.dumps(current, indent=2) + "\n")
        return

    if not SNAPSHOT.parent.exists():
        pytest.skip("frontend sources not present (e.g. backend-only Docker test image)")

    recorded = json.loads(SNAPSHOT.read_text())
    added = sorted(set(current) - set(recorded))
    removed = sorted(set(recorded) - set(current))
    assert not added and not removed, (
        "frontend/src/__tests__/api/backend-routes.json is out of date.\n"
        f"Routes added: {added}\nRoutes removed: {removed}\n"
        "Regenerate: cd backend && UPDATE_ROUTE_SNAPSHOT=1 ../venv/bin/python -m pytest "
        "tests/unit/test_api_route_snapshot.py"
    )
