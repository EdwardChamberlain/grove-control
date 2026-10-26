"""Auth dependencies in core/auth.py, run against the test database.

Each dependency repeats the same bearer-token validation, so one table of
credential scenarios runs against all of them: missing, malformed, revoked,
stale or ownerless tokens, inactive users, missing permissions, admins and
API keys.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core import auth
from backend.app.core.permissions import ADMINISTRATOR_GROUP_KEY, Permission
from backend.app.models.api_key import APIKey
from backend.app.models.group import Group
from backend.app.models.settings import Settings
from backend.app.models.user import User

READ = Permission.PRINTERS_READ
ADMIN_ONLY = Permission.USERS_DELETE


class Env:
    def __init__(self, session):
        self.session = session

    async def add(self, *rows):
        async with self.session() as db:
            db.add_all(rows)
            await db.commit()
            for row in rows:
                await db.refresh(row)

    async def enable_auth(self):
        await self.add(Settings(key="auth_enabled", value="true"))
        auth.invalidate_auth_enabled_cache()

    async def user(self, username, permissions=(), *, admin=False, active=True, password_changed_at=None):
        group = Group(
            name=f"{username}-group",
            permissions=list(permissions),
            system_key=ADMINISTRATOR_GROUP_KEY if admin else None,
        )
        user = User(username=username, password_hash="x", is_active=active, password_changed_at=password_changed_at)
        user.groups = [group]
        await self.add(group, user)
        return user

    async def api_key(self, *, owner=None, expires_at=None, enabled=True, **scopes):
        full_key, key_hash, prefix = auth.generate_api_key()
        await self.add(
            APIKey(
                name="key",
                key_hash=key_hash,
                key_prefix=prefix,
                user_id=owner.id if owner else None,
                expires_at=expires_at,
                enabled=enabled,
                **scopes,
            )
        )
        return full_key


@pytest.fixture
async def env(test_engine):
    session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    auth.invalidate_auth_enabled_cache()
    with patch("backend.app.core.auth.async_session", session):
        yield Env(session)
    auth.invalidate_auth_enabled_cache()


def bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def token_for(username: str | None, *, jti=True, iat=True, **extra) -> str:
    payload = {"exp": datetime.now(timezone.utc) + timedelta(minutes=5), **extra}
    if username is not None:
        payload["sub"] = username
    if jti:
        payload["jti"] = "jti-" + (username or "none")
    if iat:
        payload["iat"] = datetime.now(timezone.utc)
    return jwt.encode(payload, auth.SECRET_KEY, algorithm=auth.ALGORITHM)


# Dependencies that run only when auth is enabled; each returns the user (or
# a (user, can_modify_all) tuple) for an authorised caller.
CONDITIONAL = {
    "auth_if_enabled": lambda: auth.require_auth_if_enabled,
    "permission_if_enabled": lambda: auth.require_permission_if_auth_enabled(READ),
    "any_permission_if_enabled": lambda: auth.require_any_permission_if_auth_enabled(READ, ADMIN_ONLY),
    "admin_if_enabled": lambda: auth.require_admin_if_auth_enabled(),
    "ownership": lambda: auth.require_ownership_permission(
        Permission.ARCHIVES_UPDATE_ALL, Permission.ARCHIVES_UPDATE_OWN
    ),
}
ALL = {**CONDITIONAL, "permission": lambda: auth.require_permission(READ)}


async def call(dep_factory, credentials=None, x_api_key=None):
    return await dep_factory()(credentials=credentials, x_api_key=x_api_key)


def status_of(exc_info) -> int:
    return exc_info.value.status_code


class TestAuthDisabled:
    @pytest.mark.parametrize("name", list(CONDITIONAL))
    async def test_conditional_dependencies_allow_everyone(self, env, name):
        result = await call(CONDITIONAL[name])
        assert result in (None, (None, True))


class TestRejectedTokens:
    @pytest.mark.parametrize("name", list(ALL))
    async def test_missing_credentials(self, env, name):
        await env.enable_auth()
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name])
        assert status_of(exc) == 401

    @pytest.mark.parametrize("name", list(ALL))
    @pytest.mark.parametrize(
        "make_token",
        [
            lambda: "not-a-jwt",
            lambda: token_for(None),  # no subject
            lambda: token_for("ada", jti=False),  # no revocation id
            lambda: token_for("ghost"),  # unknown user
            lambda: token_for("ada", iat=False),  # no issued-at: cannot be ours
        ],
        ids=["malformed", "no-sub", "no-jti", "unknown-user", "no-iat"],
    )
    async def test_invalid_tokens(self, env, name, make_token):
        await env.enable_auth()
        await env.user("ada", [READ.value], admin=True)
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name], bearer(make_token()))
        assert status_of(exc) == 401

    @pytest.mark.parametrize("name", list(ALL))
    async def test_revoked_token(self, env, name):
        await env.enable_auth()
        await env.user("ada", [READ.value], admin=True)
        await auth.revoke_jti("jti-ada", datetime.now(timezone.utc) + timedelta(hours=1), "ada")
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name], bearer(token_for("ada")))
        assert status_of(exc) == 401

    @pytest.mark.parametrize("name", list(ALL))
    async def test_inactive_user(self, env, name):
        await env.enable_auth()
        await env.user("ada", [READ.value], admin=True, active=False)
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name], bearer(token_for("ada")))
        assert status_of(exc) == 401

    @pytest.mark.parametrize("name", list(ALL))
    async def test_token_from_before_a_password_change(self, env, name):
        await env.enable_auth()
        await env.user(
            "ada", [READ.value], admin=True, password_changed_at=datetime.now(timezone.utc) + timedelta(minutes=1)
        )
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name], bearer(token_for("ada")))
        assert status_of(exc) == 401


class TestAuthorisedUsers:
    @pytest.mark.parametrize("name", list(ALL))
    async def test_admin_passes_every_check(self, env, name):
        await env.enable_auth()
        admin = await env.user("root", admin=True)

        result = await call(ALL[name], bearer(token_for("root")))

        user = result[0] if isinstance(result, tuple) else result
        assert user.id == admin.id
        if name == "ownership":
            assert result[1] is True

    @pytest.mark.parametrize("name", ["permission", "permission_if_enabled", "any_permission_if_enabled"])
    async def test_user_with_permission(self, env, name):
        await env.enable_auth()
        await env.user("ada", [READ.value])

        assert (await call(ALL[name], bearer(token_for("ada")))).username == "ada"

    @pytest.mark.parametrize(
        "name", ["permission", "permission_if_enabled", "any_permission_if_enabled", "admin_if_enabled"]
    )
    async def test_user_without_permission_is_forbidden(self, env, name):
        await env.enable_auth()
        await env.user("bob", ["queue:read"])
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name], bearer(token_for("bob")))
        assert status_of(exc) == 403

    async def test_any_user_satisfies_auth_if_enabled(self, env):
        await env.enable_auth()
        await env.user("bob")

        assert (await call(ALL["auth_if_enabled"], bearer(token_for("bob")))).username == "bob"

    async def test_ownership_own_vs_all(self, env):
        await env.enable_auth()
        await env.user("own", [Permission.ARCHIVES_UPDATE_OWN.value])
        await env.user("all", [Permission.ARCHIVES_UPDATE_ALL.value])
        await env.user("none")

        own_user, own_all = await call(ALL["ownership"], bearer(token_for("own")))
        all_user, all_all = await call(ALL["ownership"], bearer(token_for("all")))
        assert (own_user.username, own_all) == ("own", False)
        assert (all_user.username, all_all) == ("all", True)
        with pytest.raises(HTTPException) as exc:
            await call(ALL["ownership"], bearer(token_for("none")))
        assert status_of(exc) == 403


class TestApiKeys:
    async def test_valid_key_header_and_bearer(self, env):
        await env.enable_auth()
        key = await env.api_key(can_read_status=True)

        assert await call(ALL["auth_if_enabled"], x_api_key=key) is None
        assert await call(ALL["auth_if_enabled"], bearer(key)) is None
        assert await call(ALL["permission"], x_api_key=key) is None
        assert await call(ALL["permission_if_enabled"], bearer(key)) is None
        assert await call(ALL["any_permission_if_enabled"], x_api_key=key) is None

    @pytest.mark.parametrize(
        "name", ["auth_if_enabled", "permission", "permission_if_enabled", "any_permission_if_enabled"]
    )
    async def test_invalid_bearer_key(self, env, name):
        await env.enable_auth()
        with pytest.raises(HTTPException) as exc:
            await call(ALL[name], bearer("bb_not-a-real-key-0000000000"))
        assert (status_of(exc), exc.value.detail) == (401, "Invalid API key")

    async def test_expired_and_disabled_keys_are_invalid(self, env):
        await env.enable_auth()
        expired = await env.api_key(can_read_status=True, expires_at=datetime.now(timezone.utc) - timedelta(days=1))
        disabled = await env.api_key(can_read_status=True, enabled=False)

        for key in (expired, disabled):
            with pytest.raises(HTTPException) as exc:
                await call(ALL["permission"], bearer(key))
            assert status_of(exc) == 401

    async def test_key_without_the_scope_is_forbidden(self, env):
        await env.enable_auth()
        key = await env.api_key(can_read_status=False)

        with pytest.raises(HTTPException) as exc:
            await call(ALL["permission"], x_api_key=key)
        assert (status_of(exc), exc.value.detail) == (403, "API key does not have 'can_read_status' permission")

    async def test_keys_cannot_do_administrative_operations(self, env):
        await env.enable_auth()
        key = await env.api_key(can_read_status=True)

        with pytest.raises(HTTPException) as exc:
            await auth.require_permission(ADMIN_ONLY)(credentials=None, x_api_key=key)
        assert exc.value.detail == "API keys cannot be used for administrative operations"
        with pytest.raises(HTTPException) as exc:
            await call(ALL["admin_if_enabled"], x_api_key=key)
        assert status_of(exc) == 403

    async def test_owned_key_is_limited_by_its_owner(self, env):
        await env.enable_auth()
        owner = await env.user("ada", ["queue:read"])
        key = await env.api_key(owner=owner, can_read_status=True)

        with pytest.raises(HTTPException) as exc:
            await call(ALL["permission"], x_api_key=key)
        assert exc.value.detail == "API key owner does not have 'printers:read' permission"


class TestTokens:
    async def test_websocket_token_round_trip(self, env):
        token = await auth.create_websocket_token("ada")

        assert await auth.verify_websocket_token(token) == "ada"
        assert await auth.verify_websocket_token("garbage") is None

    async def test_camera_stream_token_round_trip(self, env):
        token = await auth.create_camera_stream_token()

        assert await auth.verify_camera_stream_token(token) is True
        assert await auth.verify_camera_stream_token("garbage") is False

    async def test_slicer_download_token_is_bound_to_its_resource(self, env):
        token = await auth.create_slicer_download_token("archive", 5)

        assert await auth.verify_slicer_download_token(token, "archive", 5) is True
        assert await auth.verify_slicer_download_token(token, "archive", 6) is False
        assert await auth.verify_slicer_download_token(token, "library", 5) is False
