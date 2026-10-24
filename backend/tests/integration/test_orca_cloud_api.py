"""Integration tests for the /orca-cloud routes (auth disabled → Settings storage).

``OrcaCloudService`` is replaced with a fake so no network is touched; the
tests exercise the route layer: the PKCE start/finish handshake, password
sign-in, JIT token refresh, profile grouping/mapping and logout.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.settings import Settings
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError

ROUTES = "backend.app.api.routes.orca_cloud"


class FakeOrca:
    """Stand-in for OrcaCloudService. Class attributes configure behaviour;
    ``calls`` records what the routes asked for."""

    calls: list[tuple] = []
    exchange_error: Exception | None = None
    password_error: Exception | None = None
    refresh_error: Exception | None = None
    user_info: dict | Exception = {"email": "maker@example.com", "id": "user-1"}
    profiles: list[dict] = []
    profile: dict | Exception = {}

    def __init__(self):
        self.access_token = None
        self.refresh_token = None
        self.token_expiry = None

    @property
    def is_authenticated(self) -> bool:
        return bool(self.access_token and self.token_expiry and self.token_expiry > datetime.now(timezone.utc))

    def set_tokens(self, access_token, refresh_token, expires_at):
        self.access_token, self.refresh_token, self.token_expiry = access_token, refresh_token, expires_at

    def _issue(self, prefix: str):
        self.access_token = f"{prefix}-access"
        self.refresh_token = f"{prefix}-refresh"
        self.token_expiry = datetime.now(timezone.utc) + timedelta(hours=1)

    async def exchange_code(self, code, verifier):
        FakeOrca.calls.append(("exchange_code", code, verifier))
        if FakeOrca.exchange_error:
            raise FakeOrca.exchange_error
        self._issue("oauth")

    async def password_login(self, email, password):
        FakeOrca.calls.append(("password_login", email, password))
        if FakeOrca.password_error:
            raise FakeOrca.password_error
        self._issue("pw")

    async def refresh(self):
        FakeOrca.calls.append(("refresh", self.refresh_token))
        if FakeOrca.refresh_error:
            raise FakeOrca.refresh_error
        self._issue("rotated")

    async def get_user_info(self):
        if isinstance(FakeOrca.user_info, Exception):
            raise FakeOrca.user_info
        return FakeOrca.user_info

    async def list_profiles(self):
        FakeOrca.calls.append(("list_profiles", self.access_token))
        return FakeOrca.profiles

    async def get_profile(self, profile_id):
        FakeOrca.calls.append(("get_profile", profile_id))
        if isinstance(FakeOrca.profile, Exception):
            raise FakeOrca.profile
        return FakeOrca.profile


@pytest.fixture(autouse=True)
def fake_orca():
    FakeOrca.calls = []
    FakeOrca.exchange_error = None
    FakeOrca.password_error = None
    FakeOrca.refresh_error = None
    FakeOrca.user_info = {"email": "maker@example.com", "id": "user-1"}
    FakeOrca.profiles = []
    FakeOrca.profile = {}
    with patch(f"{ROUTES}.OrcaCloudService", FakeOrca):
        yield FakeOrca


async def _settings(db_session) -> dict[str, str]:
    result = await db_session.execute(select(Settings).where(Settings.key.like("orca_cloud_%")))
    return {s.key: s.value for s in result.scalars().all()}


async def _store_tokens(db_session, *, expires_in: timedelta, refresh: str | None = "stored-refresh"):
    rows = {
        "orca_cloud_token": "stored-access",
        "orca_cloud_expires_at": (datetime.now(timezone.utc) + expires_in).isoformat(),
        "orca_cloud_email": "maker@example.com",
    }
    if refresh:
        rows["orca_cloud_refresh_token"] = refresh
    for key, value in rows.items():
        db_session.add(Settings(key=key, value=value))
    await db_session.commit()


@pytest.mark.integration
class TestOrcaCloudHandshake:
    async def test_status_starts_disconnected(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/orca-cloud/status")
        assert response.status_code == 200
        assert response.json() == {"connected": False, "email": None, "user_id": None}

    async def test_start_then_finish_stores_tokens_and_identity(self, async_client: AsyncClient, db_session):
        start = await async_client.post("/api/v1/orca-cloud/auth/start", json={"provider": "github"})
        assert start.status_code == 200
        assert "provider=github" in start.json()["auth_url"]
        pending = await _settings(db_session)
        verifier = pending["orca_cloud_pending_verifier"]
        assert verifier and pending["orca_cloud_pending_state"]

        finish = await async_client.post(
            "/api/v1/orca-cloud/auth/finish",
            json={"callback_url": "http://localhost/callback?code=abc123"},
        )
        assert finish.status_code == 200
        assert finish.json() == {"connected": True, "email": "maker@example.com", "user_id": "user-1"}
        assert ("exchange_code", "abc123", verifier) in FakeOrca.calls

        db_session.expire_all()
        stored = await _settings(db_session)
        assert stored["orca_cloud_token"] == "oauth-access"
        assert stored["orca_cloud_refresh_token"] == "oauth-refresh"
        assert "orca_cloud_pending_verifier" not in stored  # handshake state cleared

        status = await async_client.get("/api/v1/orca-cloud/status")
        assert status.json()["connected"] is True

    async def test_finish_reads_code_from_fragment(self, async_client: AsyncClient):
        await async_client.post("/api/v1/orca-cloud/auth/start", json={})
        finish = await async_client.post(
            "/api/v1/orca-cloud/auth/finish",
            json={"callback_url": "http://localhost/callback#code=frag-code"},
        )
        assert finish.status_code == 200
        assert FakeOrca.calls[0][:2] == ("exchange_code", "frag-code")

    async def test_finish_without_start_is_rejected(self, async_client: AsyncClient):
        response = await async_client.post(
            "/api/v1/orca-cloud/auth/finish", json={"callback_url": "http://localhost/callback?code=x"}
        )
        assert response.status_code == 400
        assert "No pending" in response.json()["detail"]

    async def test_finish_after_ttl_expires_and_clears_state(self, async_client: AsyncClient, db_session):
        for key, value in {
            "orca_cloud_pending_verifier": "v",
            "orca_cloud_pending_state": "s",
            "orca_cloud_pending_at": (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat(),
        }.items():
            db_session.add(Settings(key=key, value=value))
        await db_session.commit()

        response = await async_client.post(
            "/api/v1/orca-cloud/auth/finish", json={"callback_url": "http://localhost/callback?code=x"}
        )
        assert response.status_code == 400
        assert "expired" in response.json()["detail"]
        assert FakeOrca.calls == []

        # A retry with the same stale flow is now "no pending flow".
        retry = await async_client.post(
            "/api/v1/orca-cloud/auth/finish", json={"callback_url": "http://localhost/callback?code=x"}
        )
        assert retry.status_code == 400
        assert "No pending" in retry.json()["detail"]

    async def test_finish_requires_code_in_callback(self, async_client: AsyncClient):
        await async_client.post("/api/v1/orca-cloud/auth/start", json={})
        response = await async_client.post(
            "/api/v1/orca-cloud/auth/finish", json={"callback_url": "http://localhost/callback?state=only"}
        )
        assert response.status_code == 400
        assert "No `code`" in response.json()["detail"]

    @pytest.mark.parametrize(
        ("error", "status"),
        [(OrcaCloudAuthError("bad code"), 400), (OrcaCloudError("timeout"), 502)],
    )
    async def test_finish_maps_exchange_errors(self, async_client: AsyncClient, error, status):
        FakeOrca.exchange_error = error
        await async_client.post("/api/v1/orca-cloud/auth/start", json={})
        response = await async_client.post(
            "/api/v1/orca-cloud/auth/finish", json={"callback_url": "http://localhost/callback?code=x"}
        )
        assert response.status_code == status

    async def test_finish_still_connects_when_user_info_fails(self, async_client: AsyncClient):
        FakeOrca.user_info = OrcaCloudError("profile endpoint down")
        await async_client.post("/api/v1/orca-cloud/auth/start", json={})
        response = await async_client.post(
            "/api/v1/orca-cloud/auth/finish", json={"callback_url": "http://localhost/callback?code=x"}
        )
        assert response.status_code == 200
        assert response.json() == {"connected": True, "email": None, "user_id": None}


@pytest.mark.integration
class TestOrcaCloudPasswordAndLogout:
    async def test_password_login_stores_tokens(self, async_client: AsyncClient, db_session):
        response = await async_client.post(
            "/api/v1/orca-cloud/auth/password", json={"email": "maker@example.com", "password": "pw"}
        )
        assert response.status_code == 200
        assert response.json()["connected"] is True
        assert ("password_login", "maker@example.com", "pw") in FakeOrca.calls
        assert (await _settings(db_session))["orca_cloud_token"] == "pw-access"

    @pytest.mark.parametrize(
        ("error", "status"),
        [(OrcaCloudAuthError("password grant disabled"), 400), (OrcaCloudError("dns"), 502)],
    )
    async def test_password_login_errors(self, async_client: AsyncClient, db_session, error, status):
        FakeOrca.password_error = error
        response = await async_client.post(
            "/api/v1/orca-cloud/auth/password", json={"email": "maker@example.com", "password": "pw"}
        )
        assert response.status_code == status
        assert "orca_cloud_token" not in await _settings(db_session)

    async def test_logout_clears_everything(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(hours=1))
        response = await async_client.post("/api/v1/orca-cloud/logout")
        assert response.status_code == 200
        db_session.expire_all()
        assert await _settings(db_session) == {}
        status = await async_client.get("/api/v1/orca-cloud/status")
        assert status.json()["connected"] is False


@pytest.mark.integration
class TestOrcaCloudProfiles:
    async def test_profiles_require_a_connection(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/orca-cloud/profiles")
        assert response.status_code == 401

    async def test_profiles_are_grouped_by_bambu_type(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(hours=1))
        FakeOrca.profiles = [
            {"id": "f1", "name": "My PLA", "content": {"type": "filament", "version": "1.0"}, "updated_time": 1700},
            {"id": "p1", "name": "My X1C", "content": {"type": "machine"}},
            {"id": "q1", "name": "Fine", "content": {"type": "print", "from": "User"}},
            {"id": "x1", "name": "Mystery", "content": {"type": "plugin"}},  # unknown type: dropped
            {"id": "bad", "name": "Broken", "content": "not-a-dict"},  # malformed: dropped
        ]
        response = await async_client.get("/api/v1/orca-cloud/profiles")
        assert response.status_code == 200
        body = response.json()
        assert [p["setting_id"] for p in body["filament"]] == ["f1"]
        assert body["filament"][0]["version"] == "1.0"
        assert body["filament"][0]["updated_time"] == "1700"
        assert [p["setting_id"] for p in body["printer"]] == ["p1"]
        assert [p["setting_id"] for p in body["process"]] == ["q1"]
        assert body["process"][0]["user_id"] == "User"
        # The valid stored token was used without a refresh.
        assert ("list_profiles", "stored-access") in FakeOrca.calls
        assert not any(c[0] == "refresh" for c in FakeOrca.calls)

    async def test_expired_token_is_refreshed_and_persisted(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(minutes=-5))
        response = await async_client.get("/api/v1/orca-cloud/profiles")
        assert response.status_code == 200
        assert ("refresh", "stored-refresh") in FakeOrca.calls
        assert ("list_profiles", "rotated-access") in FakeOrca.calls
        db_session.expire_all()
        stored = await _settings(db_session)
        assert stored["orca_cloud_token"] == "rotated-access"
        assert stored["orca_cloud_email"] == "maker@example.com"  # identity untouched by refresh

    async def test_expired_token_without_refresh_token_needs_sign_in(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(minutes=-5), refresh=None)
        response = await async_client.get("/api/v1/orca-cloud/profiles")
        assert response.status_code == 401
        assert "sign in again" in response.json()["detail"]

    async def test_revoked_refresh_token_clears_credentials(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(minutes=-5))
        FakeOrca.refresh_error = OrcaCloudAuthError("refresh token revoked")
        response = await async_client.get("/api/v1/orca-cloud/profiles")
        assert response.status_code == 401
        db_session.expire_all()
        assert await _settings(db_session) == {}

    async def test_refresh_network_error_keeps_credentials(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(minutes=-5))
        FakeOrca.refresh_error = OrcaCloudError("timeout")
        response = await async_client.get("/api/v1/orca-cloud/profiles")
        assert response.status_code == 502
        db_session.expire_all()
        assert (await _settings(db_session))["orca_cloud_token"] == "stored-access"

    async def test_profile_detail_maps_type_and_base(self, async_client: AsyncClient, db_session):
        await _store_tokens(db_session, expires_in=timedelta(hours=1))
        FakeOrca.profile = {
            "name": "Fine",
            "updated_time": 42,
            "content": {"type": "print", "inherits": "0.20mm Standard", "version": "2", "layer_height": "0.1"},
        }
        response = await async_client.get("/api/v1/orca-cloud/profiles/q1")
        assert response.status_code == 200
        body = response.json()
        assert body["setting_id"] == "q1"
        assert body["type"] == "process"
        assert body["base_id"] == "0.20mm Standard"
        assert body["update_time"] == "42"
        assert body["setting"]["layer_height"] == "0.1"

    @pytest.mark.parametrize(
        ("error", "status"),
        [
            (OrcaCloudError("Profile not found"), 404),
            (OrcaCloudError("upstream 500"), 502),
            (OrcaCloudAuthError("token rejected"), 401),
        ],
    )
    async def test_profile_detail_errors(self, async_client: AsyncClient, db_session, error, status):
        await _store_tokens(db_session, expires_in=timedelta(hours=1))
        FakeOrca.profile = error
        response = await async_client.get("/api/v1/orca-cloud/profiles/missing")
        assert response.status_code == status
