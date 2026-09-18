"""Integration tests for Maintenance API endpoints."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient


class TestMaintenanceTypesAPI:
    """Integration tests for /api/v1/maintenance/types endpoints."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_maintenance_types(self, async_client: AsyncClient):
        """Verify maintenance types list returns data with defaults."""
        response = await async_client.get("/api/v1/maintenance/types")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        # Should have default system types
        assert len(data) >= 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_includes_system_types(self, async_client: AsyncClient):
        """Verify default system types are created."""
        response = await async_client.get("/api/v1/maintenance/types")
        assert response.status_code == 200
        data = response.json()
        names = [t["name"] for t in data]
        # Check for some default types
        assert "Lubricate Linear Rails" in names or len(data) > 0
        waste_basket = next(item for item in data if item["name"] == "Clear waste basket")
        assert waste_basket["default_interval_hours"] == 25.0
        assert waste_basket["interval_type"] == "hours"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_custom_maintenance_type(self, async_client: AsyncClient):
        """Verify custom maintenance type can be created."""
        data = {
            "name": "Custom Test Task",
            "description": "Test description",
            "default_interval_hours": 200.0,
            "interval_type": "hours",
            "icon": "Wrench",
        }
        response = await async_client.post("/api/v1/maintenance/types", json=data)
        assert response.status_code == 200
        result = response.json()
        assert result["name"] == "Custom Test Task"
        assert result["is_system"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_custom_type_persists_wiki_url(self, async_client: AsyncClient):
        """#1596: pre-fix, the POST handler hard-coded every constructor field
        by name and silently dropped `wiki_url`. The schema accepted the value,
        the response echoed `null`, and the row landed without it. Pin the
        contract so the constructor doesn't drift again."""
        data = {
            "name": "Wiki URL Persistence Test",
            "default_interval_hours": 50.0,
            "interval_type": "hours",
            "wiki_url": "https://wiki.example.com/lubrication",
        }
        response = await async_client.post("/api/v1/maintenance/types", json=data)
        assert response.status_code == 200
        assert response.json()["wiki_url"] == "https://wiki.example.com/lubrication"

        # Verify it persists through a separate GET round-trip — the POST
        # response could have echoed the request body without committing.
        list_response = await async_client.get("/api/v1/maintenance/types")
        assert list_response.status_code == 200
        matching = [t for t in list_response.json() if t["name"] == data["name"]]
        assert len(matching) == 1
        assert matching[0]["wiki_url"] == "https://wiki.example.com/lubrication"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_maintenance_type(self, async_client: AsyncClient):
        """Verify maintenance type can be updated."""
        # First create a custom type
        create_data = {
            "name": "Update Test",
            "description": "Original",
            "default_interval_hours": 100.0,
        }
        create_response = await async_client.post("/api/v1/maintenance/types", json=create_data)
        assert create_response.status_code == 200
        type_id = create_response.json()["id"]

        # Update it
        update_data = {"description": "Updated description"}
        response = await async_client.patch(f"/api/v1/maintenance/types/{type_id}", json=update_data)
        assert response.status_code == 200
        assert response.json()["description"] == "Updated description"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_custom_maintenance_type(self, async_client: AsyncClient):
        """Verify custom maintenance type can be deleted."""
        # Create a custom type
        create_data = {
            "name": "Delete Test",
            "description": "To be deleted",
            "default_interval_hours": 50.0,
        }
        create_response = await async_client.post("/api/v1/maintenance/types", json=create_data)
        type_id = create_response.json()["id"]

        # Delete it
        response = await async_client.delete(f"/api/v1/maintenance/types/{type_id}")
        assert response.status_code == 200


class TestPrinterMaintenanceAPI:
    """Integration tests for /api/v1/maintenance/printers endpoints."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_printer_maintenance_not_found(self, async_client: AsyncClient):
        """Verify 404 for non-existent printer."""
        response = await async_client.get("/api/v1/maintenance/printers/9999")
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_printer_maintenance(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify maintenance overview for a printer."""
        printer = await printer_factory(name="Maintenance Test Printer")
        response = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["printer_id"] == printer.id
        assert data["printer_name"] == "Maintenance Test Printer"
        assert "maintenance_items" in data
        assert "total_print_hours" in data

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_vision_encoder_calibration_only_applies_to_supported_models(
        self, async_client: AsyncClient, printer_factory
    ):
        h2_printer = await printer_factory(model="H2D")
        x2_printer = await printer_factory(model="X2D")
        unsupported_printer = await printer_factory(model="P1S")

        h2_response = await async_client.get(f"/api/v1/maintenance/printers/{h2_printer.id}")
        x2_response = await async_client.get(f"/api/v1/maintenance/printers/{x2_printer.id}")
        unsupported_response = await async_client.get(f"/api/v1/maintenance/printers/{unsupported_printer.id}")

        assert h2_response.status_code == 200
        assert x2_response.status_code == 200
        assert unsupported_response.status_code == 200

        h2_tasks = {item["maintenance_type_name"]: item for item in h2_response.json()["maintenance_items"]}
        x2_tasks = {item["maintenance_type_name"]: item for item in x2_response.json()["maintenance_items"]}
        unsupported_tasks = {
            item["maintenance_type_name"]: item for item in unsupported_response.json()["maintenance_items"]
        }
        assert h2_tasks["Vision Encoder Calibration"]["interval_hours"] == 250.0
        assert x2_tasks["Vision Encoder Calibration"]["interval_hours"] == 250.0
        assert "Vision Encoder Calibration" not in unsupported_tasks

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_all_maintenance_overview(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify overview endpoint returns all printers."""
        await printer_factory(name="Overview Printer 1")
        await printer_factory(name="Overview Printer 2")
        response = await async_client.get("/api/v1/maintenance/overview")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_maintenance_summary(self, async_client: AsyncClient):
        """Verify summary endpoint returns counts."""
        response = await async_client.get("/api/v1/maintenance/summary")
        assert response.status_code == 200
        data = response.json()
        assert "total_due" in data
        assert "total_warning" in data
        assert "printers_with_issues" in data


class TestMaintenanceItemsAPI:
    """Integration tests for /api/v1/maintenance/items endpoints."""

    @pytest.fixture
    async def maintenance_item(self, async_client: AsyncClient, printer_factory, db_session):
        """Create a maintenance item for testing."""
        printer = await printer_factory(name="Item Test Printer")
        # Get the printer's maintenance overview to create items
        response = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert response.status_code == 200
        data = response.json()
        # Return the first maintenance item
        if data["maintenance_items"]:
            return data["maintenance_items"][0]
        return None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_maintenance_item(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance item can be updated."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        response = await async_client.patch(
            f"/api/v1/maintenance/items/{item_id}", json={"custom_interval_hours": 150.0}
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_disable_maintenance_item(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance item can be disabled."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        response = await async_client.patch(f"/api/v1/maintenance/items/{item_id}", json={"enabled": False})
        assert response.status_code == 200
        assert response.json()["enabled"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_perform_maintenance(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance can be marked as performed."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        response = await async_client.post(
            f"/api/v1/maintenance/items/{item_id}/perform", json={"notes": "Test maintenance performed"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["last_performed_at"] is not None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_maintenance_history(self, async_client: AsyncClient, maintenance_item):
        """Verify maintenance history can be retrieved."""
        if not maintenance_item:
            pytest.skip("No maintenance items available")

        item_id = maintenance_item["id"]
        # First perform maintenance to create history
        await async_client.post(f"/api/v1/maintenance/items/{item_id}/perform", json={"notes": "History test"})

        response = await async_client.get(f"/api/v1/maintenance/items/{item_id}/history")
        assert response.status_code == 200
        history = response.json()
        assert isinstance(history, list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_maintenance_item_not_found(self, async_client: AsyncClient):
        """Verify 404 for non-existent maintenance item."""
        response = await async_client.patch("/api/v1/maintenance/items/9999", json={"enabled": False})
        assert response.status_code == 404


class TestPrinterHoursAPI:
    """Integration tests for /api/v1/maintenance/printers/{id}/hours endpoint."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_set_printer_hours(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify printer hours can be set."""
        printer = await printer_factory(name="Hours Test Printer")
        response = await async_client.patch(
            f"/api/v1/maintenance/printers/{printer.id}/hours", params={"total_hours": 500.0}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["total_hours"] == 500.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_set_printer_hours_not_found(self, async_client: AsyncClient):
        """Verify 404 for non-existent printer."""
        response = await async_client.patch("/api/v1/maintenance/printers/9999/hours", params={"total_hours": 100.0})
        assert response.status_code == 404


class TestMaintenanceLogAPI:
    """Integration tests for the durable, fleet-wide maintenance log (#180)."""

    @staticmethod
    def _manual_payload(
        printer_id: int,
        *,
        title: str = "Replaced extruder",
        hours: float | None = 123.5,
        occurred_at: datetime | None = None,
    ) -> dict:
        return {
            "printer_id": printer_id,
            "title": title,
            "notes": "Installed a replacement extruder assembly",
            "occurred_at": (occurred_at or datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            "hours_at_maintenance": hours,
        }

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_manual_log_crud_and_filtering(self, async_client: AsyncClient, printer_factory):
        printer_one = await printer_factory(name="Log Printer One")
        printer_two = await printer_factory(name="Log Printer Two")

        created = await async_client.post("/api/v1/maintenance/logs", json=self._manual_payload(printer_one.id))
        assert created.status_code == 200
        entry = created.json()
        assert entry["entry_type"] == "manual"
        assert entry["printer_name"] == "Log Printer One"
        assert entry["hours_at_maintenance"] == 123.5

        second = await async_client.post(
            "/api/v1/maintenance/logs", json=self._manual_payload(printer_two.id, title="Replaced PTFE tube")
        )
        assert second.status_code == 200

        filtered = await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer_one.id}")
        assert filtered.status_code == 200
        assert [item["id"] for item in filtered.json()["items"]] == [entry["id"]]

        filtered_by_type = await async_client.get("/api/v1/maintenance/logs?entry_type=manual")
        assert filtered_by_type.status_code == 200
        assert all(item["entry_type"] == "manual" for item in filtered_by_type.json()["items"])

        updated = await async_client.patch(
            f"/api/v1/maintenance/logs/{entry['id']}",
            json={"printer_id": printer_two.id, "title": "Replaced extruder fan", "hours_at_maintenance": None},
        )
        assert updated.status_code == 200
        assert updated.json()["printer_id"] == printer_two.id
        assert updated.json()["title"] == "Replaced extruder fan"
        assert updated.json()["hours_at_maintenance"] is None

        deleted = await async_client.delete(f"/api/v1/maintenance/logs/{entry['id']}")
        assert deleted.status_code == 200
        assert deleted.json() == {"status": "deleted"}

        missing = await async_client.patch(f"/api/v1/maintenance/logs/{entry['id']}", json={"title": "Nope"})
        assert missing.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_manual_log_does_not_change_maintenance_status(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Manual Log Does Not Reset")
        before = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert before.status_code == 200
        before_item = before.json()["maintenance_items"][0]

        created = await async_client.post("/api/v1/maintenance/logs", json=self._manual_payload(printer.id))
        assert created.status_code == 200

        after = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert after.status_code == 200
        after_item = next(item for item in after.json()["maintenance_items"] if item["id"] == before_item["id"])
        assert after_item["last_performed_at"] == before_item["last_performed_at"]
        assert after_item["hours_since_maintenance"] == before_item["hours_since_maintenance"]
        assert after_item["hours_until_due"] == before_item["hours_until_due"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_scheduled_completion_is_logged_and_immutable(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Scheduled Log Printer")
        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        item = overview.json()["maintenance_items"][0]

        performed = await async_client.post(
            f"/api/v1/maintenance/items/{item['id']}/perform", json={"notes": "Completed as scheduled"}
        )
        assert performed.status_code == 200

        legacy_history = await async_client.get(f"/api/v1/maintenance/items/{item['id']}/history")
        assert legacy_history.status_code == 200
        assert len(legacy_history.json()) == 1

        logs = await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}&entry_type=scheduled")
        assert logs.status_code == 200
        scheduled = logs.json()["items"][0]
        assert scheduled["entry_type"] == "scheduled"
        assert scheduled["title"] == item["maintenance_type_name"]
        assert scheduled["notes"] == "Completed as scheduled"

        assert (
            await async_client.patch(f"/api/v1/maintenance/logs/{scheduled['id']}", json={"title": "Changed"})
        ).status_code == 409
        assert (await async_client.delete(f"/api/v1/maintenance/logs/{scheduled['id']}")).status_code == 409

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_scheduled_log_survives_custom_assignment_removal(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Retained Log Printer")
        type_response = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Replace enclosure filter", "default_interval_hours": 100, "interval_type": "hours"},
        )
        assert type_response.status_code == 200
        assignment = await async_client.post(
            f"/api/v1/maintenance/printers/{printer.id}/assign/{type_response.json()['id']}"
        )
        assert assignment.status_code == 200
        item_id = assignment.json()["id"]
        assert (await async_client.post(f"/api/v1/maintenance/items/{item_id}/perform", json={})).status_code == 200
        assert (await async_client.delete(f"/api/v1/maintenance/items/{item_id}")).status_code == 200

        logs = await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}")
        titles = [entry["title"] for entry in logs.json()["items"]]
        assert "Replace enclosure filter" in titles

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_log_pagination_and_future_dates(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Pagination Log Printer")
        now = datetime.now(timezone.utc)
        for title, occurred_at in (
            ("First repair", now - timedelta(hours=1)),
            ("Second repair", now - timedelta(hours=2)),
        ):
            response = await async_client.post(
                "/api/v1/maintenance/logs", json=self._manual_payload(printer.id, title=title, occurred_at=occurred_at)
            )
            assert response.status_code == 200

        first_page = await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}&limit=1")
        assert first_page.status_code == 200
        assert len(first_page.json()["items"]) == 1
        assert first_page.json()["items"][0]["title"] == "First repair"
        assert first_page.json()["next_cursor"]
        second_page = await async_client.get(
            f"/api/v1/maintenance/logs?printer_id={printer.id}&limit=1&cursor={first_page.json()['next_cursor']}"
        )
        assert second_page.status_code == 200
        assert len(second_page.json()["items"]) == 1
        assert second_page.json()["items"][0]["title"] == "Second repair"

        future = self._manual_payload(printer.id)
        future["occurred_at"] = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
        assert (await async_client.post("/api/v1/maintenance/logs", json=future)).status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_log_rejects_invalid_input_and_cursor(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Invalid Log Input Printer")

        blank_title = await async_client.post(
            "/api/v1/maintenance/logs", json=self._manual_payload(printer.id, title="   ")
        )
        assert blank_title.status_code == 422

        negative_hours = await async_client.post(
            "/api/v1/maintenance/logs", json=self._manual_payload(printer.id, hours=-1)
        )
        assert negative_hours.status_code == 422

        unknown_printer = await async_client.post("/api/v1/maintenance/logs", json=self._manual_payload(999999))
        assert unknown_printer.status_code == 404

        too_many = await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}&limit=101")
        assert too_many.status_code == 422

        invalid_cursor = await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}&cursor=not-a-cursor")
        assert invalid_cursor.status_code == 422
