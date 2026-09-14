"""Integration tests for ownership-based permission system.

Tests the ownership permission model where users can have:
- *_all permissions: can modify any item
- *_own permissions: can only modify items they created
- Ownerless items (created_by_id = null) require *_all permission
"""

import pytest
from httpx import AsyncClient


class TestOwnershipPermissionsSetup:
    """Helper fixture class for ownership permission tests."""

    @pytest.fixture
    async def auth_setup(self, async_client: AsyncClient):
        """Setup auth with admin, create test users with different permission levels."""
        # Enable auth with admin user
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "ownershipadmin",
                "admin_password": "AdminPass1!",
            },
        )

        # Login as admin
        admin_login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "ownershipadmin", "password": "AdminPass1!"},
        )
        admin_token = admin_login.json()["access_token"]
        admin_user = admin_login.json()["user"]

        # Get group IDs
        groups_response = await async_client.get(
            "/api/v1/groups/",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        groups = groups_response.json()
        operators_group = next(g for g in groups if g["name"] == "Operators")
        viewers_group = next(g for g in groups if g["name"] == "Viewers")

        # Create operator user (has *_own permissions)
        operator_response = await async_client.post(
            "/api/v1/users/",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "username": "operator1",
                "password": "Operatorpass1!",
                "group_ids": [operators_group["id"]],
            },
        )
        operator_user = operator_response.json()

        # Login as operator
        operator_login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "operator1", "password": "Operatorpass1!"},
        )
        operator_token = operator_login.json()["access_token"]

        # Create second operator (for cross-user tests)
        operator2_response = await async_client.post(
            "/api/v1/users/",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "username": "operator2",
                "password": "Operatorpass1!",
                "group_ids": [operators_group["id"]],
            },
        )
        operator2_user = operator2_response.json()

        operator2_login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "operator2", "password": "Operatorpass1!"},
        )
        operator2_token = operator2_login.json()["access_token"]

        # Create viewer user (has no update/delete permissions)
        await async_client.post(
            "/api/v1/users/",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "username": "viewer1",
                "password": "Viewerpass1!",
                "group_ids": [viewers_group["id"]],
            },
        )

        viewer_login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "viewer1", "password": "Viewerpass1!"},
        )
        viewer_token = viewer_login.json()["access_token"]

        return {
            "admin_token": admin_token,
            "admin_user": admin_user,
            "operator_token": operator_token,
            "operator_user": operator_user,
            "operator2_token": operator2_token,
            "operator2_user": operator2_user,
            "viewer_token": viewer_token,
        }


class TestArchiveOwnershipPermissions(TestOwnershipPermissionsSetup):
    """Tests for archive ownership-based permissions."""

    @pytest.fixture
    async def operator_api_key(self, db_session, auth_setup):
        """Create a fully-scoped API key owned by operator1."""
        from backend.app.core.auth import generate_api_key
        from backend.app.models.api_key import APIKey

        full_key, key_hash, key_prefix = generate_api_key()
        db_session.add(
            APIKey(
                name="operator-archive-key",
                key_hash=key_hash,
                key_prefix=key_prefix,
                user_id=auth_setup["operator_user"]["id"],
                can_read_status=True,
                can_manage_archives=True,
            )
        )
        await db_session.commit()
        return full_key

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_api_key_cannot_read_another_users_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, operator_api_key
    ):
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Operator 2 archive",
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.get(
            f"/api/v1/archives/{archive.id}",
            headers={"X-API-Key": operator_api_key},
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_api_key_cannot_update_another_users_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, operator_api_key
    ):
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Operator 2 archive",
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.patch(
            f"/api/v1/archives/{archive.id}",
            headers={"X-API-Key": operator_api_key},
            json={"print_name": "Should remain unchanged"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_api_key_cannot_delete_another_users_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, operator_api_key
    ):
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Operator 2 archive",
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.delete(
            f"/api/v1/archives/{archive.id}",
            headers={"X-API-Key": operator_api_key},
        )

        assert response.status_code == 403

    # ========================================================================
    # DELETE permissions
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_delete_any_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Admin with *_all permissions can delete any archive."""
        printer = await printer_factory()
        # Create archive owned by operator
        archive = await archive_factory(
            printer.id,
            print_name="Operator Archive",
            created_by_id=auth_setup["operator_user"]["id"],
        )

        # Admin deletes it
        response = await async_client.delete(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_delete_own_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Operator with *_own permissions can delete their own archive."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="My Archive",
            created_by_id=auth_setup["operator_user"]["id"],
        )

        response = await async_client.delete(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_delete_others_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Operator with *_own permissions cannot delete another user's archive."""
        printer = await printer_factory()
        # Archive created by operator2
        archive = await archive_factory(
            printer.id,
            print_name="Other's Archive",
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        # operator1 tries to delete it
        response = await async_client.delete(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403
        assert "your own" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_delete_ownerless_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Operator with *_own permissions cannot delete ownerless archive."""
        printer = await printer_factory()
        # Archive with no owner (legacy data)
        archive = await archive_factory(
            printer.id,
            print_name="Ownerless Archive",
            created_by_id=None,
        )

        response = await async_client.delete(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_viewer_cannot_delete_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Viewer with no delete permissions cannot delete any archive."""
        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="Any Archive")

        response = await async_client.delete(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['viewer_token']}"},
        )

        assert response.status_code == 403

    # ========================================================================
    # UPDATE permissions
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_update_any_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Admin can update any archive."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Original Name",
            created_by_id=auth_setup["operator_user"]["id"],
        )

        response = await async_client.patch(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
            json={"print_name": "Admin Updated"},
        )

        assert response.status_code == 200
        assert response.json()["print_name"] == "Admin Updated"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_update_own_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Operator can update their own archive."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Original Name",
            created_by_id=auth_setup["operator_user"]["id"],
        )

        response = await async_client.patch(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"print_name": "Operator Updated"},
        )

        assert response.status_code == 200
        assert response.json()["print_name"] == "Operator Updated"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_update_others_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Operator cannot update another user's archive."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Other's Archive",
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.patch(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"print_name": "Attempted Update"},
        )

        assert response.status_code == 403

    # ========================================================================
    # Legacy reprint endpoint
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reprint_endpoint_is_gone_for_all_callers(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Direct archive reprint no longer exists; callers must use the queue."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.post(
            f"/api/v1/archives/{archive.id}/reprint?printer_id={printer.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 410

    # ========================================================================
    # Queue route — archives:reprint_* gate (#1625)
    # ========================================================================
    # The unified /queue/ route replaced the legacy /reprint endpoint; the
    # reprint permission gate must move with it. Without these checks a
    # caller with QUEUE_CREATE + ARCHIVES_READ_OWN could reprint their own
    # archives even if explicitly denied ARCHIVES_REPRINT_OWN.

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_queue_route_operator_can_reprint_own_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Operator with REPRINT_OWN can queue their own archive."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            created_by_id=auth_setup["operator_user"]["id"],
        )

        response = await async_client.post(
            "/api/v1/queue/",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"printer_id": printer.id, "archive_id": archive.id},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_queue_route_user_without_reprint_gets_403(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """User with QUEUE_CREATE + ARCHIVES_READ_OWN but no reprint perm → 403.

        Custom group mirrors a real operator policy where someone is allowed
        to enqueue freshly-uploaded library files but explicitly NOT allowed
        to re-run completed archives.
        """
        # Create custom group with queue:create + archives:read_own but no reprint perm.
        admin_headers = {"Authorization": f"Bearer {auth_setup['admin_token']}"}
        group_resp = await async_client.post(
            "/api/v1/groups/",
            headers=admin_headers,
            json={
                "name": "QueueOnlyNoReprint",
                "description": "Test group: can queue library files but not reprint",
                "permissions": [
                    "queue:create",
                    "queue:read_own",
                    "archives:read_own",
                    "library:read_own",
                    "library:upload",
                    "printers:read",
                ],
            },
        )
        assert group_resp.status_code in (200, 201)
        group_id = group_resp.json()["id"]

        await async_client.post(
            "/api/v1/users/",
            headers=admin_headers,
            json={
                "username": "noreprint_user",
                "password": "NoreprintPass1!",
                "group_ids": [group_id],
            },
        )
        login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "noreprint_user", "password": "NoreprintPass1!"},
        )
        token = login.json()["access_token"]
        user_id = login.json()["user"]["id"]

        # Archive owned by the no-reprint user.
        printer = await printer_factory()
        archive = await archive_factory(printer.id, created_by_id=user_id)

        response = await async_client.post(
            "/api/v1/queue/",
            headers={"Authorization": f"Bearer {token}"},
            json={"printer_id": printer.id, "archive_id": archive.id},
        )

        assert response.status_code == 403
        assert "reprint" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_batch_dispatch_allowed_for_own_archive_with_reprint_own(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """The dispatch gate must not block the ordinary self-service case (#342)."""
        headers = {"Authorization": f"Bearer {auth_setup['operator_token']}"}
        printer = await printer_factory()
        archive = await archive_factory(printer.id, created_by_id=auth_setup["operator_user"]["id"])

        order = await async_client.post(
            "/api/v1/queue/batches",
            headers=headers,
            json={
                "name": "Own order",
                "archive_id": archive.id,
                "plates": [{"plate_id": 1, "quantity_target": 2}],
            },
        )
        assert order.status_code == 200
        batch_id = order.json()["id"]
        assert (
            await async_client.post(
                "/api/v1/queue/",
                headers=headers,
                json={
                    "printer_id": printer.id,
                    "archive_id": archive.id,
                    "batch_id": batch_id,
                    "plate_id": 1,
                },
            )
        ).status_code == 200

        response = await async_client.post(f"/api/v1/queue/batches/{batch_id}/dispatch", headers=headers, json={})
        assert response.status_code == 200
        assert response.json()["remaining_count"] == 0
        assert response.json()["pending_count"] == 2

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_batch_dispatch_honours_the_reprint_gate(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Dispatching a batch order must not be a weaker door than POST /queue/ (#342).

        Dispatch clones existing queue items, so without the same source-file
        gate a caller holding queue:create and queue:update_all — but
        explicitly denied archives:reprint_* — could start prints of an
        archive that POST /queue/ would have refused them.
        """
        admin_headers = {"Authorization": f"Bearer {auth_setup['admin_token']}"}
        group_resp = await async_client.post(
            "/api/v1/groups/",
            headers=admin_headers,
            json={
                "name": "BatchDispatchNoReprint",
                "description": "Test group: can manage the queue but not reprint archives",
                "permissions": [
                    "queue:create",
                    "queue:read_all",
                    "queue:update_all",
                    "archives:read_all",
                    "printers:read",
                ],
            },
        )
        assert group_resp.status_code in (200, 201)
        await async_client.post(
            "/api/v1/users/",
            headers=admin_headers,
            json={
                "username": "batch_noreprint_user",
                "password": "BatchNoreprint1!",
                "group_ids": [group_resp.json()["id"]],
            },
        )
        login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "batch_noreprint_user", "password": "BatchNoreprint1!"},
        )
        token = login.json()["access_token"]

        # Admin builds an order with one dispatched run and two still owed.
        printer = await printer_factory()
        archive = await archive_factory(printer.id, created_by_id=auth_setup["admin_user"]["id"])
        order = await async_client.post(
            "/api/v1/queue/batches",
            headers=admin_headers,
            json={
                "name": "Gated order",
                "archive_id": archive.id,
                "plates": [{"plate_id": 1, "quantity_target": 3}],
            },
        )
        assert order.status_code == 200
        batch_id = order.json()["id"]
        seeded = await async_client.post(
            "/api/v1/queue/",
            headers=admin_headers,
            json={"printer_id": printer.id, "archive_id": archive.id, "batch_id": batch_id, "plate_id": 1},
        )
        assert seeded.status_code == 200

        response = await async_client.post(
            f"/api/v1/queue/batches/{batch_id}/dispatch",
            headers={"Authorization": f"Bearer {token}"},
            json={},
        )

        assert response.status_code == 403
        assert "reprint" in response.json()["detail"].lower()

        # And nothing was queued behind the refusal.
        listing = await async_client.get(f"/api/v1/queue/batches/{batch_id}", headers=admin_headers)
        assert listing.json()["pending_count"] == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_queue_route_ownerless_archive_requires_reprint_all(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Ownerless archive (created_by_id=null) requires REPRINT_ALL.

        Pre-IDOR-fix legacy data has no creator; an operator with
        REPRINT_OWN can't fall back to "I own this" — fail-closed.
        The existing IDOR check returns 404 first (operator lacks
        READ_ALL and doesn't own the row), so this is also a regression
        guard against accidentally surfacing 403-instead-of-404 if the
        IDOR check is ever loosened.
        """
        printer = await printer_factory()
        archive = await archive_factory(printer.id, created_by_id=None)

        response = await async_client.post(
            "/api/v1/queue/",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"printer_id": printer.id, "archive_id": archive.id},
        )

        # IDOR returns 404 before the new gate fires for this operator.
        assert response.status_code == 404


class TestQueueOwnershipPermissions(TestOwnershipPermissionsSetup):
    """Tests for print queue ownership-based permissions."""

    @pytest.fixture
    async def queue_item_factory(self, db_session, printer_factory, archive_factory):
        """Factory to create test queue items."""

        async def _create_item(**kwargs):
            from backend.app.models.print_queue import PrintQueueItem

            printer = await printer_factory()
            # Create an archive to link to the queue item
            archive = await archive_factory(printer.id)

            defaults = {
                "printer_id": printer.id,
                "archive_id": archive.id,
                "status": "pending",
                "position": 0,
            }
            defaults.update(kwargs)

            item = PrintQueueItem(**defaults)
            db_session.add(item)
            await db_session.commit()
            await db_session.refresh(item)
            return item

        return _create_item

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_delete_any_queue_item(self, async_client: AsyncClient, auth_setup, queue_item_factory):
        """Admin can delete any queue item."""
        item = await queue_item_factory(created_by_id=auth_setup["operator_user"]["id"])

        response = await async_client.delete(
            f"/api/v1/queue/{item.id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_delete_own_queue_item(self, async_client: AsyncClient, auth_setup, queue_item_factory):
        """Operator can delete their own queue item."""
        item = await queue_item_factory(created_by_id=auth_setup["operator_user"]["id"])

        response = await async_client.delete(
            f"/api/v1/queue/{item.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_delete_others_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory
    ):
        """Operator cannot delete another user's queue item."""
        item = await queue_item_factory(created_by_id=auth_setup["operator2_user"]["id"])

        response = await async_client.delete(
            f"/api/v1/queue/{item.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_update_own_queue_item(self, async_client: AsyncClient, auth_setup, queue_item_factory):
        """Operator can update their own queue item."""
        item = await queue_item_factory(created_by_id=auth_setup["operator_user"]["id"])

        response = await async_client.patch(
            f"/api/v1/queue/{item.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"position": 10},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_update_others_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory
    ):
        """Operator cannot update another user's queue item."""
        item = await queue_item_factory(created_by_id=auth_setup["operator2_user"]["id"])

        response = await async_client.patch(
            f"/api/v1/queue/{item.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"position": 10},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_cancel_others_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory
    ):
        """Operator cannot cancel another user's queue item."""
        item = await queue_item_factory(created_by_id=auth_setup["operator2_user"]["id"])

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/cancel",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    # ========================================================================
    # Start / Stop ownership gates (#1625-followup)
    # ========================================================================
    # Pre-fix /stop required QUEUE_UPDATE_ALL (admin-only) — operators saw the
    # Stop button in the queue UI but got 403 on click. /start required
    # QUEUE_UPDATE_OWN with no ownership check — operators could start anyone's
    # queue items via direct API. Both now use require_ownership_permission.

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_start_own_queue_item(self, async_client: AsyncClient, auth_setup, queue_item_factory):
        """Operator can start their own staged queue item."""
        item = await queue_item_factory(
            created_by_id=auth_setup["operator_user"]["id"],
            manual_start=True,
        )

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/start?skip_filament_check=true",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_start_others_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory
    ):
        """Operator cannot start another user's queue item."""
        item = await queue_item_factory(
            created_by_id=auth_setup["operator2_user"]["id"],
            manual_start=True,
        )

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/start?skip_filament_check=true",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_start_unowned_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory, db_session
    ):
        """Operator can start a NULL-owner queue item (VP-uploaded, #1670)
        and claims ownership in the process.

        Stop and Cancel reject unowned items for _OWN holders (destructive,
        no "I own it" claim available), but Start is the entry point for the
        VP-import flow where attribution happens at click-time.
        """
        from backend.app.models.print_queue import PrintQueueItem

        item = await queue_item_factory(created_by_id=None, manual_start=True)

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/start?skip_filament_check=true",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 200
        # Ownership claimed: operator is now the item's owner.
        await db_session.refresh(item)
        refetch = await db_session.get(PrintQueueItem, item.id)
        assert refetch.created_by_id == auth_setup["operator_user"]["id"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("status", ["dispatching", "printing"])
    async def test_operator_can_stop_own_active_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory, status
    ):
        """Operator can stop their own dispatching or printing queue item."""
        item = await queue_item_factory(
            created_by_id=auth_setup["operator_user"]["id"],
            status=status,
        )

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/stop",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_stop_others_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory
    ):
        """Operator cannot stop another user's printing queue item."""
        item = await queue_item_factory(
            created_by_id=auth_setup["operator2_user"]["id"],
            status="printing",
        )

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/stop",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_stop_unowned_queue_item(
        self, async_client: AsyncClient, auth_setup, queue_item_factory
    ):
        """Operator cannot stop a NULL-owner printing queue item — stop mirrors
        cancel (destructive, no claim semantics). Admins with _ALL can still stop it.
        """
        item = await queue_item_factory(created_by_id=None, status="printing")

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/stop",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_stop_any_queue_item(self, async_client: AsyncClient, auth_setup, queue_item_factory):
        """Admin with _ALL can stop any printing queue item including unowned."""
        item = await queue_item_factory(created_by_id=None, status="printing")

        response = await async_client.post(
            f"/api/v1/queue/{item.id}/stop",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bulk_update_skips_non_owned_items(self, async_client: AsyncClient, auth_setup, queue_item_factory):
        """Bulk update only updates items the user owns."""
        # Create items owned by different users
        own_item = await queue_item_factory(
            created_by_id=auth_setup["operator_user"]["id"],
        )
        other_item = await queue_item_factory(
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.patch(
            "/api/v1/queue/bulk",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={
                "item_ids": [own_item.id, other_item.id],
                "manual_start": True,
            },
        )

        assert response.status_code == 200
        result = response.json()
        # Should only update the owned item
        assert result["updated_count"] == 1
        assert result["skipped_count"] == 1


class TestLibraryOwnershipPermissions(TestOwnershipPermissionsSetup):
    """Tests for library file ownership-based permissions."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_read_own_cannot_poll_another_users_slice_job(
        self, async_client: AsyncClient, auth_setup, db_session
    ):
        """Slice-job results must follow the source owner's read boundary."""
        from backend.app.core.auth import generate_api_key
        from backend.app.models.api_key import APIKey
        from backend.app.services.slice_dispatch import SliceJob, slice_dispatch

        full_key, key_hash, key_prefix = generate_api_key()
        db_session.add(
            APIKey(
                name="slice-job-reader-key",
                key_hash=key_hash,
                key_prefix=key_prefix,
                user_id=auth_setup["operator2_user"]["id"],
                can_read_status=True,
            )
        )
        await db_session.commit()

        job = SliceJob(
            id=990001,
            kind="library_file",
            source_id=123,
            source_name="operator1-private.3mf",
            owner_id=auth_setup["operator_user"]["id"],
            status="completed",
            result={"library_file_id": 456},
        )
        slice_dispatch._jobs[job.id] = job
        try:
            jwt_response = await async_client.get(
                f"/api/v1/slice-jobs/{job.id}",
                headers={"Authorization": f"Bearer {auth_setup['operator2_token']}"},
            )
            assert jwt_response.status_code == 404

            api_key_response = await async_client.get(
                f"/api/v1/slice-jobs/{job.id}",
                headers={"X-API-Key": full_key},
            )
            assert api_key_response.status_code == 404

            owner_response = await async_client.get(
                f"/api/v1/slice-jobs/{job.id}",
                headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            )
            assert owner_response.status_code == 200
            assert owner_response.json()["source_name"] == "operator1-private.3mf"
        finally:
            slice_dispatch._jobs.pop(job.id, None)

    @pytest.fixture
    async def library_file_factory(self, db_session):
        """Factory to create test library files."""
        _counter = [0]

        async def _create_file(**kwargs):
            from backend.app.models.library import LibraryFile

            _counter[0] += 1
            defaults = {
                "filename": f"test_{_counter[0]}.3mf",
                "file_path": f"library/test_{_counter[0]}.3mf",
                "file_type": "3mf",
                "file_size": 1024,
            }
            defaults.update(kwargs)

            file = LibraryFile(**defaults)
            db_session.add(file)
            await db_session.commit()
            await db_session.refresh(file)
            return file

        return _create_file

    @pytest.fixture
    async def library_folder_factory(self, db_session):
        """Factory to create test library folders."""
        _counter = [0]

        async def _create_folder(**kwargs):
            from backend.app.models.library import LibraryFolder

            _counter[0] += 1
            defaults = {
                "name": f"TestFolder_{_counter[0]}",
            }
            defaults.update(kwargs)

            folder = LibraryFolder(**defaults)
            db_session.add(folder)
            await db_session.commit()
            await db_session.refresh(folder)
            return folder

        return _create_folder

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_delete_any_library_file(self, async_client: AsyncClient, auth_setup, library_file_factory):
        """Admin can delete any library file."""
        file = await library_file_factory(created_by_id=auth_setup["operator_user"]["id"])

        response = await async_client.delete(
            f"/api/v1/library/files/{file.id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_delete_own_library_file(
        self, async_client: AsyncClient, auth_setup, library_file_factory
    ):
        """Operator can delete their own library file."""
        file = await library_file_factory(created_by_id=auth_setup["operator_user"]["id"])

        response = await async_client.delete(
            f"/api/v1/library/files/{file.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_delete_others_library_file(
        self, async_client: AsyncClient, auth_setup, library_file_factory
    ):
        """Operator cannot delete another user's library file."""
        file = await library_file_factory(created_by_id=auth_setup["operator2_user"]["id"])

        response = await async_client.delete(
            f"/api/v1/library/files/{file.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_update_own_library_file(
        self, async_client: AsyncClient, auth_setup, library_file_factory
    ):
        """Operator can update their own library file."""
        file = await library_file_factory(created_by_id=auth_setup["operator_user"]["id"])

        response = await async_client.put(
            f"/api/v1/library/files/{file.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"filename": "renamed.3mf"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_update_others_library_file(
        self, async_client: AsyncClient, auth_setup, library_file_factory
    ):
        """Operator cannot update another user's library file."""
        file = await library_file_factory(created_by_id=auth_setup["operator2_user"]["id"])

        response = await async_client.put(
            f"/api/v1/library/files/{file.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"filename": "renamed.3mf"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_folders_require_all_permission(self, async_client: AsyncClient, auth_setup, library_folder_factory):
        """Folders require *_all permission (no ownership tracking on folders)."""
        folder = await library_folder_factory(name="TestFolder")

        # Operator cannot delete folder (needs *_all)
        response = await async_client.delete(
            f"/api/v1/library/folders/{folder.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bulk_delete_nested_folder_releases_queue_reference(
        self, async_client: AsyncClient, auth_setup, db_session
    ):
        """Nested files must be detached/cancelled before folder cascade."""
        from backend.app.models.library import LibraryFile, LibraryFolder
        from backend.app.models.print_queue import PrintQueueItem

        parent = LibraryFolder(name="bulk-parent")
        db_session.add(parent)
        await db_session.flush()
        child = LibraryFolder(name="bulk-child", parent_id=parent.id)
        db_session.add(child)
        await db_session.flush()
        nested_file = LibraryFile(
            folder_id=child.id,
            filename="nested.3mf",
            file_path="library/nested.3mf",
            file_type="3mf",
            file_size=10,
            created_by_id=auth_setup["admin_user"]["id"],
        )
        db_session.add(nested_file)
        await db_session.flush()
        queue_item = PrintQueueItem(library_file_id=nested_file.id, status="pending", position=1)
        db_session.add(queue_item)
        await db_session.commit()
        await db_session.refresh(queue_item)

        response = await async_client.post(
            "/api/v1/library/bulk-delete",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
            json={"file_ids": [], "folder_ids": [parent.id]},
        )

        assert response.status_code == 200
        await db_session.refresh(queue_item)
        assert queue_item.status == "cancelled"
        assert queue_item.library_file_id is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bulk_delete_skips_non_owned_files(self, async_client: AsyncClient, auth_setup, library_file_factory):
        """Bulk delete only deletes files the user owns."""
        own_file = await library_file_factory(
            filename="own.3mf",
            created_by_id=auth_setup["operator_user"]["id"],
        )
        other_file = await library_file_factory(
            filename="other.3mf",
            created_by_id=auth_setup["operator2_user"]["id"],
        )

        response = await async_client.post(
            "/api/v1/library/bulk-delete",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"file_ids": [own_file.id, other_file.id], "folder_ids": []},
        )

        assert response.status_code == 200
        result = response.json()
        # Should only delete the owned file; other_file is skipped (but skipped count not in response)
        assert result["deleted_files"] == 1


class TestAuthDisabledPermissions:
    """Tests that verify all operations are allowed when auth is disabled."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_archive_without_auth(
        self, async_client: AsyncClient, archive_factory, printer_factory, db_session
    ):
        """When auth is disabled, anyone can delete archives."""
        printer = await printer_factory()
        archive = await archive_factory(printer.id)

        response = await async_client.delete(f"/api/v1/archives/{archive.id}")

        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_archive_without_auth(
        self, async_client: AsyncClient, archive_factory, printer_factory, db_session
    ):
        """When auth is disabled, anyone can update archives."""
        printer = await printer_factory()
        archive = await archive_factory(printer.id)

        response = await async_client.patch(
            f"/api/v1/archives/{archive.id}",
            json={"print_name": "Updated Name"},
        )

        assert response.status_code == 200


class TestUserItemsCountAndDeletion(TestOwnershipPermissionsSetup):
    """Tests for user items count endpoint and deletion with items."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_user_items_count(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Verify items count endpoint returns correct counts."""
        printer = await printer_factory()
        user_id = auth_setup["operator_user"]["id"]

        # Create some items for the operator
        await archive_factory(printer.id, created_by_id=user_id)
        await archive_factory(printer.id, created_by_id=user_id)

        response = await async_client.get(
            f"/api/v1/users/{user_id}/items-count",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 200
        counts = response.json()
        assert counts["archives"] >= 2
        assert "queue_items" in counts
        assert "library_files" in counts

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_user_keeps_items(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Verify deleting user without delete_items keeps items (ownerless)."""
        printer = await printer_factory()
        user_id = auth_setup["operator2_user"]["id"]

        # Create archive for operator2
        archive = await archive_factory(printer.id, created_by_id=user_id)
        archive_id = archive.id

        # Delete user without deleting items
        response = await async_client.delete(
            f"/api/v1/users/{user_id}?delete_items=false",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 204

        # Verify archive still exists but is now ownerless
        archive_response = await async_client.get(
            f"/api/v1/archives/{archive_id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )
        assert archive_response.status_code == 200
        assert archive_response.json()["created_by_id"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_user_with_items(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Verify deleting user with delete_items=true removes their items."""
        printer = await printer_factory()

        # Create a new user with items
        create_response = await async_client.post(
            "/api/v1/users/",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
            json={
                "username": "deletewithitems",
                "password": "Password123!",
            },
        )
        user_id = create_response.json()["id"]

        # Create archive for this user
        archive = await archive_factory(printer.id, created_by_id=user_id)
        archive_id = archive.id

        # Delete user WITH deleting items
        response = await async_client.delete(
            f"/api/v1/users/{user_id}?delete_items=true",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )

        assert response.status_code == 204

        # Verify archive was deleted
        archive_response = await async_client.get(
            f"/api/v1/archives/{archive_id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )
        assert archive_response.status_code == 404


class TestReadIDORClosure(TestOwnershipPermissionsSetup):
    """Regression tests for an IDOR on
    archives / library / queue read paths.

    Before the fix, ARCHIVES_READ / LIBRARY_READ / QUEUE_READ were flat
    "see everything" permissions even though the write side was split into
    OWN/ALL. An operator with only ARCHIVES_READ could read, download, and
    queue any user's archive via direct id reference. These tests pin the
    archive_idor.py and archive_viewer_idor.py PoC paths
    so the IDOR can't regress silently.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_get_others_archive_returns_404_not_200(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """PoC #2 read path. operator1 GET /archives/{id} where id is admin's
        archive must NOT leak the row. 404 (not 403) so the operator can't
        enumerate which ids exist — same shape as a nonexistent id."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Admin Archive",
            created_by_id=auth_setup["admin_user"]["id"],
        )
        response = await async_client.get(
            f"/api/v1/archives/{archive.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_download_others_archive_returns_404(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Viewer-IDOR PoC path: GET /archives/{id}/download on admin's archive.
        Before the fix this streamed the 3MF body straight to a viewer-tier
        token."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Admin Archive 2",
            created_by_id=auth_setup["admin_user"]["id"],
        )
        response = await async_client.get(
            f"/api/v1/archives/{archive.id}/download",
            headers={"Authorization": f"Bearer {auth_setup['viewer_token']}"},
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_list_archives_excludes_others(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """GET /archives/ must filter to own archives only for OWN-level callers."""
        printer = await printer_factory()
        own = await archive_factory(
            printer.id, print_name="Operator's Own", created_by_id=auth_setup["operator_user"]["id"]
        )
        others = await archive_factory(printer.id, print_name="Admin's", created_by_id=auth_setup["admin_user"]["id"])
        response = await async_client.get(
            "/api/v1/archives/",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 200
        returned_ids = {a["id"] for a in response.json()}
        assert own.id in returned_ids
        assert others.id not in returned_ids

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_list_archives_includes_all(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """ARCHIVES_READ_ALL → admin sees own + every user's archives."""
        printer = await printer_factory()
        admin_archive = await archive_factory(
            printer.id, print_name="Admin's", created_by_id=auth_setup["admin_user"]["id"]
        )
        operator_archive = await archive_factory(
            printer.id, print_name="Operator's", created_by_id=auth_setup["operator_user"]["id"]
        )
        response = await async_client.get(
            "/api/v1/archives/",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )
        assert response.status_code == 200
        returned_ids = {a["id"] for a in response.json()}
        assert admin_archive.id in returned_ids
        assert operator_archive.id in returned_ids

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_queue_others_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """PoC #2 queue path. POST /queue/ with admin's archive_id as
        operator1 must return 404, not create a queue item. Before the fix
        this returned 201 and queued the admin archive (Landon's CONFIRMED
        line in the PoC)."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Admin Archive (queue-target)",
            created_by_id=auth_setup["admin_user"]["id"],
        )
        response = await async_client.post(
            "/api/v1/queue/",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json={"archive_id": archive.id, "printer_id": printer.id, "quantity": 1},
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_queue_others_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Belt-and-suspenders for the ALL path: admin (ARCHIVES_READ_ALL) can
        queue a user's archive on their behalf — common workshop pattern."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Operator's archive (queue by admin)",
            created_by_id=auth_setup["operator_user"]["id"],
        )
        response = await async_client.post(
            "/api/v1/queue/",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
            json={"archive_id": archive.id, "printer_id": printer.id, "quantity": 1},
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_get_others_library_file_returns_404(
        self, async_client: AsyncClient, auth_setup, db_session
    ):
        """Library IDOR closure (same shape as archives — closed in the same PR
        as required by the ownership security model)."""
        from backend.app.models.library import LibraryFile

        admin_file = LibraryFile(
            filename="admin_secret.3mf",
            file_path="library/admin_secret.3mf",
            file_type="3mf",
            file_size=2048,
            created_by_id=auth_setup["admin_user"]["id"],
        )
        db_session.add(admin_file)
        await db_session.commit()
        await db_session.refresh(admin_file)

        response = await async_client.get(
            f"/api/v1/library/files/{admin_file.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_list_library_files_excludes_others(self, async_client: AsyncClient, auth_setup, db_session):
        from backend.app.models.library import LibraryFile

        own = LibraryFile(
            filename="my_file.3mf",
            file_path="library/my_file.3mf",
            file_type="3mf",
            file_size=1024,
            created_by_id=auth_setup["operator_user"]["id"],
        )
        others = LibraryFile(
            filename="admin_file.3mf",
            file_path="library/admin_file.3mf",
            file_type="3mf",
            file_size=1024,
            created_by_id=auth_setup["admin_user"]["id"],
        )
        db_session.add_all([own, others])
        await db_session.commit()
        await db_session.refresh(own)
        await db_session.refresh(others)

        response = await async_client.get(
            "/api/v1/library/files",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 200
        returned_ids = {f["id"] for f in response.json()}
        assert own.id in returned_ids
        assert others.id not in returned_ids

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_queue_list_excludes_others_items(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """GET /queue/ must filter to own queue items only for OWN callers —
        same shape as the archive list."""
        from backend.app.models.print_queue import PrintQueueItem

        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="A", created_by_id=auth_setup["operator_user"]["id"])
        own_item = PrintQueueItem(
            archive_id=archive.id,
            printer_id=printer.id,
            status="pending",
            position=1,
            created_by_id=auth_setup["operator_user"]["id"],
        )
        admin_item = PrintQueueItem(
            archive_id=archive.id,
            printer_id=printer.id,
            status="pending",
            position=2,
            created_by_id=auth_setup["admin_user"]["id"],
        )
        db_session.add_all([own_item, admin_item])
        await db_session.commit()
        await db_session.refresh(own_item)
        await db_session.refresh(admin_item)

        response = await async_client.get(
            "/api/v1/queue/",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 200
        returned_ids = {q["id"] for q in response.json()}
        assert own_item.id in returned_ids
        assert admin_item.id not in returned_ids

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_get_others_queue_item_returns_404(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Direct-id queue item access — same enumeration risk as archive get."""
        from backend.app.models.print_queue import PrintQueueItem

        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="A", created_by_id=auth_setup["admin_user"]["id"])
        admin_item = PrintQueueItem(
            archive_id=archive.id,
            printer_id=printer.id,
            status="pending",
            position=1,
            created_by_id=auth_setup["admin_user"]["id"],
        )
        db_session.add(admin_item)
        await db_session.commit()
        await db_session.refresh(admin_item)

        response = await async_client.get(
            f"/api/v1/queue/{admin_item.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_auth_disabled_preserves_single_tenant_read_all(
        self, async_client: AsyncClient, archive_factory, printer_factory
    ):
        """With auth disabled, ARCHIVES_READ resolves to read-all (can_modify_all=True
        in require_ownership_permission's auth-disabled branch). Existing
        single-user installs see no behavior change."""
        printer = await printer_factory()
        archive = await archive_factory(printer.id, print_name="Anonymous", created_by_id=None)
        # No Authorization header — auth-disabled mode.
        response = await async_client.get(f"/api/v1/archives/{archive.id}")
        # Either 200 (auth disabled in this test session) or 401 (auth enabled
        # from a prior test) — both are acceptable; the IDOR closure does not
        # change auth-enable/disable behavior. Pin not-404 to avoid masking a
        # regression where auth-disabled callers would lose access.
        assert response.status_code in (200, 401)


# Every archive WRITE sub-resource route: (id, http method, path suffix, request kwargs).
# The ownership gate (_ensure_archive_visible) fires immediately after the fetch,
# before any resource-specific logic, so a not-owned / ownerless row 404s regardless
# of whether the timelapse / photo / source / f3d actually exists. Upload routes still
# need a body so FastAPI reaches the handler instead of 422-ing on the missing File(...).
_WRITE_SUBRESOURCE_ROUTES = [
    ("favorite", "post", "/favorite", {}),
    ("timelapse_delete", "delete", "/timelapse", {}),
    ("photo_upload", "post", "/photos", {"files": {"file": ("x.jpg", b"\x89PNG\r\n\x1a\n", "image/jpeg")}}),
    ("photo_delete", "delete", "/photos/nonexistent.jpg", {}),
    ("project_page", "patch", "/project-page", {"json": {"title": "hijacked"}}),
    ("source_upload", "post", "/source", {"files": {"file": ("x.3mf", b"PK\x03\x04", "application/octet-stream")}}),
    ("source_delete", "delete", "/source", {}),
    ("f3d_upload", "post", "/f3d", {"files": {"file": ("x.f3d", b"f3d-bytes", "application/octet-stream")}}),
    ("f3d_delete", "delete", "/f3d", {}),
]


class TestWriteSubResourceIDORClosure(TestOwnershipPermissionsSetup):
    """Regression tests for the archive write SUB-RESOURCE IDOR.

    The read sub-resource routes were closed under maziggy/bambuddy-security #2
    via ``_ensure_archive_visible``, but the *write* sub-resource routes
    (favorite, timelapse, photos, project-page, source, f3d) were left gating
    on the bare ``RequirePermissionIfAuthEnabled(ARCHIVES_*_OWN)`` scope and
    fetched the row by id only — never comparing ``created_by_id`` to the
    caller. An operator holding only ``ARCHIVES_*_OWN`` (or an API key with
    ``can_manage_archives``) could delete/overwrite files on ANY user's
    archive, most severely rewriting the project-page metadata inside another
    user's ``.3mf`` on disk. Each route is now gated by
    ``require_ownership_permission`` + ``_ensure_archive_visible`` → 404 (not
    403, to stay non-enumerable and match the read side) on a not-owned or
    ownerless row.
    """

    @pytest.mark.parametrize(
        "name,method,suffix,kwargs",
        _WRITE_SUBRESOURCE_ROUTES,
        ids=[r[0] for r in _WRITE_SUBRESOURCE_ROUTES],
    )
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_write_others_archive_subresource(
        self,
        async_client: AsyncClient,
        auth_setup,
        archive_factory,
        printer_factory,
        db_session,
        name,
        method,
        suffix,
        kwargs,
    ):
        """SECURITY.md rule 4: right credentials, wrong ownership → 404.

        operator1 (ARCHIVES_*_OWN) targeting a route on admin's archive.
        """
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Admin's Archive",
            created_by_id=auth_setup["admin_user"]["id"],
        )
        response = await getattr(async_client, method)(
            f"/api/v1/archives/{archive.id}{suffix}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            **kwargs,
        )
        assert response.status_code == 404, f"{name}: expected 404, got {response.status_code}"

    @pytest.mark.parametrize(
        "name,method,suffix,kwargs",
        _WRITE_SUBRESOURCE_ROUTES,
        ids=[r[0] for r in _WRITE_SUBRESOURCE_ROUTES],
    )
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_write_ownerless_archive_subresource(
        self,
        async_client: AsyncClient,
        auth_setup,
        archive_factory,
        printer_factory,
        db_session,
        name,
        method,
        suffix,
        kwargs,
    ):
        """Ownerless rows (created_by_id = null, legacy data) require *_ALL — an
        operator with only *_OWN has no 'I own this' claim, so fail closed → 404."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Ownerless Archive",
            created_by_id=None,
        )
        response = await getattr(async_client, method)(
            f"/api/v1/archives/{archive.id}{suffix}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            **kwargs,
        )
        assert response.status_code == 404, f"{name}: expected 404, got {response.status_code}"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_favorite_own_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Positive control: the owner still gets through the new gate. Favorite
        is the one write sub-resource that needs no pre-existing file, so it
        cleanly proves the *_OWN happy path returns 200 (not a false 404)."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Operator's Own",
            created_by_id=auth_setup["operator_user"]["id"],
        )
        response = await async_client.post(
            f"/api/v1/archives/{archive.id}/favorite",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert response.status_code == 200
        assert response.json()["is_favorite"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_favorite_any_archive(
        self, async_client: AsyncClient, auth_setup, archive_factory, printer_factory, db_session
    ):
        """Positive control for the *_ALL path: admin can act on a user's archive."""
        printer = await printer_factory()
        archive = await archive_factory(
            printer.id,
            print_name="Operator's Own",
            created_by_id=auth_setup["operator_user"]["id"],
        )
        response = await async_client.post(
            f"/api/v1/archives/{archive.id}/favorite",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )
        assert response.status_code == 200


class TestSliceOwnershipPermissions(TestOwnershipPermissionsSetup):
    """IDOR regression: slicing and slice-job polling must honour per-row ownership.

    Before the fix, ``POST /library/files/{id}/slice`` and
    ``POST /archives/{id}/slice`` gated only on ``LIBRARY_UPLOAD``, so a
    READ_OWN operator could slice another user's model by raw id even though a
    direct GET on that id returned 404 — the sliced output was then attributed
    to and downloadable by the requester. ``GET /slice-jobs/{id}`` had no owner
    scoping at all. ``POST /slicer-pipelines/{id}/run`` (and check-eligibility)
    resolved the source by raw id with the same gap.

    The slice route enforces the gate before touching the source bytes, so the
    owner/READ_ALL "control" cases reach the later on-disk check (a distinct 404
    detail) rather than a real slice — enough to prove the gate lets them past.
    """

    # Any preset triplet: the ownership 404 fires before preset resolution.
    _SLICE_BODY = {"printer_preset_id": 1, "process_preset_id": 2, "filament_preset_id": 3}

    @pytest.fixture
    async def owner_api_key(self, db_session, auth_setup):
        from backend.app.core.auth import generate_api_key
        from backend.app.models.api_key import APIKey

        full_key, key_hash, key_prefix = generate_api_key()
        db_session.add(
            APIKey(
                name="slice-owner-key",
                key_hash=key_hash,
                key_prefix=key_prefix,
                user_id=auth_setup["operator_user"]["id"],
                can_read_status=True,
                can_manage_library=True,
            )
        )
        await db_session.commit()
        return full_key

    @pytest.fixture
    async def library_file_factory(self, db_session):
        _counter = [0]

        async def _create_file(**kwargs):
            from backend.app.models.library import LibraryFile

            _counter[0] += 1
            defaults = {
                "filename": f"slice_src_{_counter[0]}.3mf",
                "file_path": f"library/slice_src_{_counter[0]}.3mf",
                "file_type": "3mf",
                "file_size": 1024,
            }
            defaults.update(kwargs)
            row = LibraryFile(**defaults)
            db_session.add(row)
            await db_session.commit()
            await db_session.refresh(row)
            return row

        return _create_file

    # --- library file slice ------------------------------------------------

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_slice_others_library_file(self, async_client, auth_setup, library_file_factory):
        file = await library_file_factory(created_by_id=auth_setup["operator2_user"]["id"])
        resp = await async_client.post(
            f"/api/v1/library/files/{file.id}/slice",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json=self._SLICE_BODY,
        )
        assert resp.status_code == 404
        # 404 (not 403) so a probing operator can't tell the id exists.
        assert resp.json()["detail"] == "File not found"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_slice_own_library_file(self, async_client, auth_setup, library_file_factory):
        file = await library_file_factory(created_by_id=auth_setup["operator_user"]["id"])
        resp = await async_client.post(
            f"/api/v1/library/files/{file.id}/slice",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json=self._SLICE_BODY,
        )
        # Past the ownership gate — only the on-disk source is missing in tests.
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Source file missing on disk"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_admin_can_slice_any_library_file(self, async_client, auth_setup, library_file_factory):
        file = await library_file_factory(created_by_id=auth_setup["operator2_user"]["id"])
        resp = await async_client.post(
            f"/api/v1/library/files/{file.id}/slice",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
            json=self._SLICE_BODY,
        )
        # READ_ALL passes the gate even on another user's file.
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Source file missing on disk"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_api_key_cannot_slice_another_users_library_file(
        self, async_client, auth_setup, library_file_factory, owner_api_key
    ):
        file = await library_file_factory(created_by_id=auth_setup["operator2_user"]["id"])
        resp = await async_client.post(
            f"/api/v1/library/files/{file.id}/slice",
            headers={"X-API-Key": owner_api_key},
            json=self._SLICE_BODY,
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "File not found"

    # --- archive slice -----------------------------------------------------

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_cannot_slice_others_archive(
        self, async_client, auth_setup, archive_factory, printer_factory
    ):
        printer = await printer_factory()
        archive = await archive_factory(printer.id, created_by_id=auth_setup["operator2_user"]["id"])
        resp = await async_client.post(
            f"/api/v1/archives/{archive.id}/slice",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json=self._SLICE_BODY,
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Archive not found"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_operator_can_slice_own_archive(self, async_client, auth_setup, archive_factory, printer_factory):
        printer = await printer_factory()
        archive = await archive_factory(printer.id, created_by_id=auth_setup["operator_user"]["id"])
        resp = await async_client.post(
            f"/api/v1/archives/{archive.id}/slice",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
            json=self._SLICE_BODY,
        )
        # Past the gate — the archive's source file isn't on disk in tests.
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Archive source file missing on disk"

    # --- slice-job polling -------------------------------------------------

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_slice_job_polling_is_owner_scoped(self, async_client, auth_setup):
        from backend.app.services.slice_dispatch import slice_dispatch

        async def _noop(_job_id):
            return {}

        job = await slice_dispatch.enqueue(
            kind="library_file",
            source_id=1,
            source_name="secret_model.3mf",
            owner_id=auth_setup["operator2_user"]["id"],
            run=_noop,
        )

        # Non-owner without READ_ALL cannot see the job (404, not 403).
        other = await async_client.get(
            f"/api/v1/slice-jobs/{job.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator_token']}"},
        )
        assert other.status_code == 404

        # The owner and a READ_ALL admin can.
        owner = await async_client.get(
            f"/api/v1/slice-jobs/{job.id}",
            headers={"Authorization": f"Bearer {auth_setup['operator2_token']}"},
        )
        assert owner.status_code == 200
        admin = await async_client.get(
            f"/api/v1/slice-jobs/{job.id}",
            headers={"Authorization": f"Bearer {auth_setup['admin_token']}"},
        )
        assert admin.status_code == 200


class TestProjectOwnershipBoundaries(TestOwnershipPermissionsSetup):
    """Project child routes must retain the API-key owner's row boundary."""

    @pytest.fixture
    async def project_api_key(self, db_session, auth_setup):
        from backend.app.core.auth import generate_api_key
        from backend.app.models.api_key import APIKey

        full_key, key_hash, key_prefix = generate_api_key()
        db_session.add(
            APIKey(
                name="operator-project-key",
                key_hash=key_hash,
                key_prefix=key_prefix,
                user_id=auth_setup["operator_user"]["id"],
                can_read_status=True,
                can_manage_projects=True,
            )
        )
        await db_session.commit()
        return full_key

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_api_key_project_routes_only_expose_owned_children(
        self,
        async_client: AsyncClient,
        db_session,
        auth_setup,
        archive_factory,
        printer_factory,
        project_api_key,
    ):
        from backend.app.models.print_queue import PrintQueueItem
        from backend.app.models.project import Project

        project = Project(name="Shared project")
        db_session.add(project)
        await db_session.flush()

        child = Project(name="Shared child", parent_id=project.id, target_count=1)
        db_session.add(child)
        await db_session.flush()

        printer = await printer_factory()
        owned_archive = await archive_factory(
            printer.id,
            print_name="Owned archive",
            created_by_id=auth_setup["operator_user"]["id"],
            project_id=project.id,
        )
        other_archive = await archive_factory(
            printer.id,
            print_name="Other archive",
            created_by_id=auth_setup["operator2_user"]["id"],
            project_id=project.id,
        )
        await archive_factory(
            printer.id,
            print_name="Owned child archive",
            status="failed",
            created_by_id=auth_setup["operator_user"]["id"],
            project_id=child.id,
        )
        await archive_factory(
            printer.id,
            print_name="Other child archive",
            status="completed",
            created_by_id=auth_setup["operator2_user"]["id"],
            project_id=child.id,
        )
        owned_item = PrintQueueItem(
            printer_id=printer.id,
            archive_id=owned_archive.id,
            project_id=project.id,
            created_by_id=auth_setup["operator_user"]["id"],
            status="pending",
            position=1,
        )
        other_item = PrintQueueItem(
            printer_id=printer.id,
            archive_id=other_archive.id,
            project_id=project.id,
            created_by_id=auth_setup["operator2_user"]["id"],
            status="pending",
            position=2,
        )
        db_session.add_all([owned_item, other_item])
        await db_session.commit()

        headers = {"X-API-Key": project_api_key}
        archives_response = await async_client.get(f"/api/v1/projects/{project.id}/archives", headers=headers)
        assert archives_response.status_code == 200, archives_response.text
        assert [item["id"] for item in archives_response.json()] == [owned_archive.id]

        queue_response = await async_client.get(f"/api/v1/projects/{project.id}/queue", headers=headers)
        assert queue_response.status_code == 200, queue_response.text
        assert [item["id"] for item in queue_response.json()] == [owned_item.id]

        timeline_response = await async_client.get(f"/api/v1/projects/{project.id}/timeline", headers=headers)
        assert timeline_response.status_code == 200, timeline_response.text
        timeline = timeline_response.json()
        assert all((event.get("metadata") or {}).get("archive_id") != other_archive.id for event in timeline)
        assert all((event.get("metadata") or {}).get("queue_item_id") != other_item.id for event in timeline)

        list_response = await async_client.get("/api/v1/projects/", headers=headers)
        assert list_response.status_code == 200, list_response.text
        listed_project = next(item for item in list_response.json() if item["id"] == project.id)
        assert listed_project["archive_count"] == 1
        assert listed_project["queue_count"] == 1
        assert [item["id"] for item in listed_project["archives"]] == [owned_archive.id]

        detail_response = await async_client.get(f"/api/v1/projects/{project.id}", headers=headers)
        assert detail_response.status_code == 200, detail_response.text
        detail = detail_response.json()
        assert detail["stats"]["total_archives"] == 1
        assert detail["stats"]["queued_prints"] == 1
        assert detail["stats"]["completed_prints"] == 1
        assert len(detail["children"]) == 1
        assert detail["children"][0]["id"] == child.id
        assert detail["children"][0]["progress_percent"] == 0.0

        remove_response = await async_client.post(
            f"/api/v1/projects/{project.id}/remove-archives",
            headers=headers,
            json={"archive_ids": [other_archive.id]},
        )
        assert remove_response.status_code == 200, remove_response.text
        assert "Removed 0" in remove_response.json()["message"]

        await db_session.refresh(other_archive)
        assert other_archive.project_id == project.id
