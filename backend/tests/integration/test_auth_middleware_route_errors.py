"""Regression tests for issue #299: route errors vs. the auth-probe fail-closed path.

With auth disabled, an unhandled error raised by a route must surface as a
normal 500 and must not be reported as an auth-probe failure (503). A failing
auth probe must still fail closed with 503 (GHSA-6mf4-q26m-47pv).
"""

import logging
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

PROBE_LOG = "failing closed on auth-probe error"
BOOM_PATH = "/api/v1/_test_auth_middleware_boom"


@pytest.fixture
def boom_route():
    """Temporarily register an /api route that raises an unhandled error."""
    from backend.app.main import app

    async def _boom():
        raise RuntimeError("route exploded")

    app.add_api_route(BOOM_PATH, _boom, methods=["GET"])
    # Move to the front so no catch-all route registered earlier shadows it.
    route = app.router.routes.pop()
    app.router.routes.insert(0, route)
    try:
        yield BOOM_PATH
    finally:
        app.router.routes.remove(route)


@pytest.fixture
async def lenient_client(async_client):
    """Client that returns the 500 response instead of re-raising app exceptions."""
    from backend.app.main import app

    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as c:
        yield c


class TestAuthMiddlewareRouteErrors:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_route_error_with_auth_disabled_returns_500(self, lenient_client, boom_route, caplog):
        with caplog.at_level(logging.ERROR):
            resp = await lenient_client.get(boom_route)

        assert resp.status_code == 500
        assert "Authentication service temporarily unavailable" not in resp.text
        assert PROBE_LOG not in caplog.text

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_failing_auth_probe_still_fails_closed(self, lenient_client, caplog):
        with (
            patch("backend.app.core.auth.is_auth_enabled", AsyncMock(side_effect=RuntimeError("db down"))),
            caplog.at_level(logging.ERROR),
        ):
            resp = await lenient_client.get("/api/v1/printers/")

        assert resp.status_code == 503
        assert resp.json() == {"detail": "Authentication service temporarily unavailable"}
        assert PROBE_LOG in caplog.text
