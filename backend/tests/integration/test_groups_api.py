"""Integration tests for the /api/v1/groups/* endpoints.

Issue #1083: updates to a group's permission list must persist across GET,
regardless of whether the frontend invalidates its React Query cache.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.database import seed_default_groups
from backend.app.core.permissions import ADMINISTRATOR_GROUP_KEY
from backend.app.models.group import Group
from backend.app.models.oidc_provider import OIDCProvider


async def _setup_admin(async_client: AsyncClient) -> dict[str, str]:
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "gadmin", "admin_password": "AdminPass1!"},
    )
    resp = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "gadmin", "password": "AdminPass1!"},
    )
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_group_permissions_persists(async_client: AsyncClient, db_session):
    """PATCH /groups/{id} with a new permissions list must persist to DB (#1083)."""
    headers = await _setup_admin(async_client)

    create = await async_client.post(
        "/api/v1/groups/",
        headers=headers,
        json={
            "name": "test_perms",
            "permissions": ["printers:read", "archives:read", "queue:read", "inventory:read"],
        },
    )
    assert create.status_code == 201
    gid = create.json()["id"]

    # Update to a wholly different set
    update = await async_client.patch(
        f"/api/v1/groups/{gid}",
        headers=headers,
        json={"permissions": ["users:read", "groups:read"]},
    )
    assert update.status_code == 200
    assert sorted(update.json()["permissions"]) == ["groups:read", "users:read"]

    # Re-read via API — must reflect the update, not the creation
    got = await async_client.get(f"/api/v1/groups/{gid}", headers=headers)
    assert got.status_code == 200
    assert sorted(got.json()["permissions"]) == ["groups:read", "users:read"]

    # Direct DB read — same expectation
    result = await db_session.execute(select(Group).where(Group.id == gid))
    assert sorted(result.scalar_one().permissions or []) == ["groups:read", "users:read"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_group_to_empty_permissions(async_client: AsyncClient, db_session):
    """Clearing all permissions via PATCH must result in an empty list, not a no-op."""
    headers = await _setup_admin(async_client)

    create = await async_client.post(
        "/api/v1/groups/",
        headers=headers,
        json={"name": "test_clear", "permissions": ["printers:read", "archives:read"]},
    )
    gid = create.json()["id"]

    update = await async_client.patch(
        f"/api/v1/groups/{gid}",
        headers=headers,
        json={"permissions": []},
    )
    assert update.status_code == 200
    assert update.json()["permissions"] == []

    got = await async_client.get(f"/api/v1/groups/{gid}", headers=headers)
    assert got.json()["permissions"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_group_without_permissions_field_preserves_existing(async_client: AsyncClient, db_session):
    """PATCH without a permissions field (None) must leave the existing list untouched."""
    headers = await _setup_admin(async_client)

    create = await async_client.post(
        "/api/v1/groups/",
        headers=headers,
        json={"name": "test_preserve", "permissions": ["printers:read", "archives:read"]},
    )
    gid = create.json()["id"]

    # Only update description
    update = await async_client.patch(
        f"/api/v1/groups/{gid}",
        headers=headers,
        json={"description": "updated"},
    )
    assert update.status_code == 200
    assert sorted(update.json()["permissions"]) == ["archives:read", "printers:read"]
    assert update.json()["description"] == "updated"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_group_invalid_permission_rejected(async_client: AsyncClient):
    """Invalid permission strings yield 400 and do not persist."""
    headers = await _setup_admin(async_client)

    create = await async_client.post(
        "/api/v1/groups/",
        headers=headers,
        json={"name": "test_bad", "permissions": ["printers:read"]},
    )
    gid = create.json()["id"]

    update = await async_client.patch(
        f"/api/v1/groups/{gid}",
        headers=headers,
        json={"permissions": ["printers:read", "bogus:permission"]},
    )
    assert update.status_code == 400
    assert "Invalid permissions" in update.json()["detail"]

    # Existing value unchanged
    got = await async_client.get(f"/api/v1/groups/{gid}", headers=headers)
    assert got.json()["permissions"] == ["printers:read"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_only_administrators_are_system_groups(async_client: AsyncClient):
    """Operators and Viewers are starter groups, not protected system groups."""
    headers = await _setup_admin(async_client)

    response = await async_client.get("/api/v1/groups/", headers=headers)

    assert response.status_code == 200
    groups = {group["name"]: group for group in response.json()}
    assert groups["Administrators"]["is_system"] is True
    assert groups["Operators"]["is_system"] is False
    assert groups["Viewers"]["is_system"] is False


@pytest.mark.asyncio
@pytest.mark.integration
async def test_operator_group_can_be_renamed_and_edited(async_client: AsyncClient):
    """Starter groups support the same edits as custom groups."""
    headers = await _setup_admin(async_client)
    groups = (await async_client.get("/api/v1/groups/", headers=headers)).json()
    operators = next(group for group in groups if group["name"] == "Operators")

    response = await async_client.patch(
        f"/api/v1/groups/{operators['id']}",
        headers=headers,
        json={"name": "Print Operators", "permissions": ["printers:read"]},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Print Operators"
    assert response.json()["permissions"] == ["printers:read"]
    assert response.json()["is_system"] is False


@pytest.mark.asyncio
@pytest.mark.integration
async def test_deleted_starter_group_is_not_recreated(async_client: AsyncClient):
    """Reseeding keeps a deliberately deleted optional default deleted."""
    headers = await _setup_admin(async_client)
    groups = (await async_client.get("/api/v1/groups/", headers=headers)).json()
    viewers = next(group for group in groups if group["name"] == "Viewers")

    response = await async_client.delete(f"/api/v1/groups/{viewers['id']}", headers=headers)
    assert response.status_code == 204

    await seed_default_groups()

    groups_after = (await async_client.get("/api/v1/groups/", headers=headers)).json()
    assert "Viewers" not in {group["name"] for group in groups_after}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_existing_starter_group_permissions_survive_flag_migration(
    async_client: AsyncClient,
    db_session,
):
    """Unlocking legacy starter groups does not replace their permissions."""
    headers = await _setup_admin(async_client)
    result = await db_session.execute(select(Group).where(Group.name == "Operators"))
    operators = result.scalar_one()
    operators.is_system = True
    operators.permissions = ["printers:read"]
    await db_session.commit()

    await seed_default_groups()

    await db_session.refresh(operators)
    assert operators.is_system is False
    assert operators.permissions == ["printers:read"]
    response = await async_client.get("/api/v1/groups/", headers=headers)
    operator_response = next(group for group in response.json() if group["name"] == "Operators")
    assert operator_response["permissions"] == ["printers:read"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_administrators_remain_protected(async_client: AsyncClient):
    """The canonical Administrators group retains all edit/delete guards."""
    headers = await _setup_admin(async_client)
    groups = (await async_client.get("/api/v1/groups/", headers=headers)).json()
    administrators = next(group for group in groups if group["name"] == "Administrators")

    rename = await async_client.patch(
        f"/api/v1/groups/{administrators['id']}",
        headers=headers,
        json={"name": "Superusers"},
    )
    permissions = await async_client.patch(
        f"/api/v1/groups/{administrators['id']}",
        headers=headers,
        json={"permissions": ["groups:read"]},
    )
    delete = await async_client.delete(f"/api/v1/groups/{administrators['id']}", headers=headers)

    assert rename.status_code == 400
    assert permissions.status_code == 400
    assert delete.status_code == 400


@pytest.mark.asyncio
@pytest.mark.integration
async def test_renamed_administrator_group_keeps_identity_and_protection(async_client: AsyncClient, db_session):
    """Admin behavior follows the stable key, not the display name."""
    headers = await _setup_admin(async_client)
    result = await db_session.execute(select(Group).where(Group.system_key == ADMINISTRATOR_GROUP_KEY))
    administrators = result.scalar_one()
    original_id = administrators.id

    administrators.name = "Administrateurs"
    await db_session.commit()

    me = await async_client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["is_admin"] is True

    deactivate = await async_client.patch(
        f"/api/v1/users/{me.json()['id']}",
        headers=headers,
        json={"is_active": False},
    )
    assert deactivate.status_code == 400

    groups = await async_client.get("/api/v1/groups/", headers=headers)
    renamed = next(group for group in groups.json() if group["id"] == original_id)
    assert renamed["name"] == "Administrateurs"

    delete = await async_client.delete(f"/api/v1/groups/{original_id}", headers=headers)
    assert delete.status_code == 400


@pytest.mark.asyncio
@pytest.mark.integration
async def test_legacy_administrator_row_is_adopted_without_changing_id_or_membership(
    async_client: AsyncClient,
    db_session,
):
    """The one-time legacy migration preserves the canonical row and users."""
    headers = await _setup_admin(async_client)
    result = await db_session.execute(select(Group).where(Group.name == "Administrators"))
    administrators = result.scalar_one()
    original_id = administrators.id
    administrators.name = "Administrateurs"
    administrators.system_key = None
    await db_session.commit()

    await seed_default_groups()

    await db_session.refresh(administrators)
    assert administrators.id == original_id
    assert administrators.name == "Administrateurs"
    assert administrators.system_key == ADMINISTRATOR_GROUP_KEY
    me = await async_client.get("/api/v1/auth/me", headers=headers)
    assert me.json()["is_admin"] is True


@pytest.mark.asyncio
@pytest.mark.integration
async def test_deleting_group_clears_oidc_default_on_sqlite(async_client: AsyncClient, db_session):
    """Deleting a configured group clears its OIDC reference transactionally."""
    headers = await _setup_admin(async_client)
    group_response = await async_client.post(
        "/api/v1/groups/",
        headers=headers,
        json={"name": "SSO Default", "permissions": ["printers:read"]},
    )
    group_id = group_response.json()["id"]

    provider_response = await async_client.post(
        "/api/v1/auth/oidc/providers",
        headers=headers,
        json={
            "name": "GroupDeleteProvider",
            "issuer_url": "https://group-delete.example.com",
            "client_id": "group-delete-client",
            "client_secret": "secret",
            "scopes": "openid",
            "is_enabled": True,
            "auto_create_users": False,
            "default_group_id": group_id,
        },
    )
    assert provider_response.status_code == 201, provider_response.text
    provider_id = provider_response.json()["id"]

    rename = await async_client.patch(
        f"/api/v1/groups/{group_id}",
        headers=headers,
        json={"name": "Renamed SSO Default"},
    )
    assert rename.status_code == 200

    provider_before_delete = await async_client.get("/api/v1/auth/oidc/providers/all", headers=headers)
    configured = next(provider for provider in provider_before_delete.json() if provider["id"] == provider_id)
    assert configured["default_group_id"] == group_id

    delete = await async_client.delete(f"/api/v1/groups/{group_id}", headers=headers)
    assert delete.status_code == 204

    provider_after_delete = await async_client.get("/api/v1/auth/oidc/providers/all", headers=headers)
    cleared = next(provider for provider in provider_after_delete.json() if provider["id"] == provider_id)
    assert cleared["default_group_id"] is None

    db_provider = await db_session.get(OIDCProvider, provider_id)
    assert db_provider is not None
    assert db_provider.default_group_id is None
