"""Integration tests for filament-change based maintenance intervals (#337)."""

import pytest
from httpx import AsyncClient


async def _assign_changes_task(
    async_client: AsyncClient, printer, *, interval: float = 20, name: str = "Replace cutter blade"
):
    """Create a filament-change task and assign it to a printer; returns (type_id, item_id)."""
    created = await async_client.post(
        "/api/v1/maintenance/types",
        json={"name": name, "default_interval_hours": interval, "interval_type": "changes"},
    )
    assert created.status_code == 200
    assert created.json()["interval_type"] == "changes"
    assigned = await async_client.post(f"/api/v1/maintenance/printers/{printer.id}/assign/{created.json()['id']}")
    assert assigned.status_code == 200
    return created.json()["id"], assigned.json()["id"]


async def _overview(async_client: AsyncClient, printer) -> dict:
    response = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
    assert response.status_code == 200
    return response.json()


async def _item(async_client: AsyncClient, printer, type_id: int) -> dict:
    overview = await _overview(async_client, printer)
    return next(i for i in overview["maintenance_items"] if i["maintenance_type_id"] == type_id)


async def _set_changes(db_session, printer, count: int) -> None:
    printer.filament_change_count = count
    await db_session.commit()


class TestChangeIntervalStatus:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_counts_changes_since_last_service(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory(name="Changes Status Printer")
        type_id, _ = await _assign_changes_task(async_client, printer, interval=20)
        await _set_changes(db_session, printer, 7)

        item = await _item(async_client, printer, type_id)

        assert item["interval_type"] == "changes"
        assert item["interval_hours"] == 20
        assert item["current_changes"] == 7
        assert item["changes_since_maintenance"] == 7
        assert item["changes_until_due"] == 13
        assert item["is_due"] is False
        assert item["is_warning"] is False
        # The other measures are not the basis for this type.
        assert item["jobs_since_maintenance"] is None
        assert item["jobs_until_due"] is None
        assert item["days_until_due"] is None
        assert item["hours_until_due"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        ("changes", "due", "warning"),
        [(17, False, False), (18, False, True), (20, True, False), (25, True, False)],
    )
    async def test_warning_and_due_thresholds(
        self, async_client: AsyncClient, printer_factory, db_session, changes, due, warning
    ):
        """Same rule as the other types: warn inside the last 10% of the interval, due at or past it."""
        printer = await printer_factory(name=f"Changes Threshold {changes}")
        type_id, _ = await _assign_changes_task(async_client, printer, interval=20)
        await _set_changes(db_session, printer, changes)

        item = await _item(async_client, printer, type_id)

        assert (item["is_due"], item["is_warning"]) == (due, warning)
        assert (await _overview(async_client, printer))["total_filament_changes"] == changes

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_jobs_and_changes_tasks_count_independently(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Both Counters Printer")
        changes_type, _ = await _assign_changes_task(async_client, printer, interval=100, name="Cutter")
        jobs_created = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Nozzle", "default_interval_hours": 10, "interval_type": "jobs"},
        )
        jobs_type = jobs_created.json()["id"]
        await async_client.post(f"/api/v1/maintenance/printers/{printer.id}/assign/{jobs_type}")
        printer.print_job_count = 4
        printer.filament_change_count = 60
        await db_session.commit()

        changes_item = await _item(async_client, printer, changes_type)
        jobs_item = await _item(async_client, printer, jobs_type)

        assert (changes_item["changes_since_maintenance"], changes_item["jobs_since_maintenance"]) == (60, None)
        assert (jobs_item["jobs_since_maintenance"], jobs_item["changes_since_maintenance"]) == (4, None)
        assert jobs_item["current_changes"] == changes_item["current_changes"] == 60
        assert jobs_item["current_jobs"] == changes_item["current_jobs"] == 4

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_hours_tasks_report_no_change_progress(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory(name="Hours Task Printer")
        await _set_changes(db_session, printer, 9)

        overview = await _overview(async_client, printer)
        hours_item = next(i for i in overview["maintenance_items"] if i["interval_type"] == "hours")

        assert hours_item["current_changes"] == 9
        assert hours_item["changes_since_maintenance"] is None
        assert hours_item["changes_until_due"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_printer_can_override_a_task_to_count_changes(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Override Printer")
        await _set_changes(db_session, printer, 3)
        overview = await _overview(async_client, printer)
        target = next(i for i in overview["maintenance_items"] if i["interval_type"] == "hours")

        patched = await async_client.patch(
            f"/api/v1/maintenance/items/{target['id']}",
            json={"custom_interval_type": "changes", "custom_interval_hours": 5},
        )
        assert patched.status_code == 200

        item = await _item(async_client, printer, target["maintenance_type_id"])
        assert item["interval_type"] == "changes"
        assert item["interval_hours"] == 5
        assert item["changes_until_due"] == 2


class TestPerformResetsChangeCount:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_perform_snapshots_changes_and_restarts_the_count(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Perform Changes Printer")
        type_id, item_id = await _assign_changes_task(async_client, printer, interval=20)
        await _set_changes(db_session, printer, 24)
        assert (await _item(async_client, printer, type_id))["is_due"] is True

        performed = await async_client.post(f"/api/v1/maintenance/items/{item_id}/perform", json={"notes": "New blade"})

        assert performed.status_code == 200
        body = performed.json()
        assert body["interval_type"] == "changes"
        assert body["current_changes"] == 24
        assert body["changes_since_maintenance"] == 0
        assert body["changes_until_due"] == 20
        assert body["is_due"] is False

        # The count is preserved on both the task history and the durable log.
        history = (await async_client.get(f"/api/v1/maintenance/items/{item_id}/history")).json()
        assert [h["changes_at_maintenance"] for h in history] == [24]
        logs = (await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}&entry_type=scheduled")).json()
        assert [entry["changes_at_maintenance"] for entry in logs["items"]] == [24]

        # Changes after the service count from the snapshot, not from zero.
        await _set_changes(db_session, printer, 31)
        item = await _item(async_client, printer, type_id)
        assert item["changes_since_maintenance"] == 7
        assert item["changes_until_due"] == 13
        assert item["is_due"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_performing_a_jobs_task_does_not_reset_a_changes_task(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Independent Reset Printer")
        changes_type, _ = await _assign_changes_task(async_client, printer, interval=20)
        jobs_created = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Jobs task", "default_interval_hours": 10, "interval_type": "jobs"},
        )
        jobs_assignment = await async_client.post(
            f"/api/v1/maintenance/printers/{printer.id}/assign/{jobs_created.json()['id']}"
        )
        printer.filament_change_count = 12
        printer.print_job_count = 12
        await db_session.commit()

        assert (
            await async_client.post(f"/api/v1/maintenance/items/{jobs_assignment.json()['id']}/perform", json={})
        ).status_code == 200

        assert (await _item(async_client, printer, changes_type))["changes_since_maintenance"] == 12

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_manual_log_entries_do_not_invent_a_change_count(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Manual Log Changes Printer")

        created = await async_client.post(
            "/api/v1/maintenance/logs", json={"printer_id": printer.id, "title": "Replaced cutter"}
        )

        assert created.status_code == 200
        assert created.json()["changes_at_maintenance"] is None


class TestIntervalTypeValidation:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_type_can_be_switched_to_changes(self, async_client: AsyncClient):
        created = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Switch to changes", "default_interval_hours": 100, "interval_type": "hours"},
        )
        assert created.status_code == 200

        updated = await async_client.patch(
            f"/api/v1/maintenance/types/{created.json()['id']}",
            json={"interval_type": "changes", "default_interval_hours": 40},
        )

        assert updated.status_code == 200
        assert updated.json()["interval_type"] == "changes"
        assert updated.json()["default_interval_hours"] == 40

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_still_rejects_unknown_interval_types(self, async_client: AsyncClient):
        response = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Bad interval", "default_interval_hours": 10, "interval_type": "cuts"},
        )
        assert response.status_code == 422
