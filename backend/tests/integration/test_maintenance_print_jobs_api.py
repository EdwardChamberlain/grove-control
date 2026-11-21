"""Integration tests for print-job based maintenance intervals (#337)."""

import pytest
from httpx import AsyncClient


async def _assign_jobs_task(async_client: AsyncClient, printer, *, interval: float = 10, name: str = "Replace nozzle"):
    """Create a job-count task and assign it to a printer; returns (type_id, item_id)."""
    created = await async_client.post(
        "/api/v1/maintenance/types",
        json={"name": name, "default_interval_hours": interval, "interval_type": "jobs"},
    )
    assert created.status_code == 200
    assert created.json()["interval_type"] == "jobs"
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


async def _set_jobs(db_session, printer, count: int) -> None:
    printer.print_job_count = count
    await db_session.commit()


class TestJobIntervalStatus:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_counts_jobs_since_last_service(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory(name="Jobs Status Printer")
        type_id, _ = await _assign_jobs_task(async_client, printer, interval=10)
        await _set_jobs(db_session, printer, 4)

        item = await _item(async_client, printer, type_id)

        assert item["interval_type"] == "jobs"
        assert item["interval_hours"] == 10
        assert item["current_jobs"] == 4
        assert item["jobs_since_maintenance"] == 4
        assert item["jobs_until_due"] == 6
        assert item["is_due"] is False
        assert item["is_warning"] is False
        # Calendar fields are not the measure for this type.
        assert item["days_since_maintenance"] is None
        assert item["days_until_due"] is None
        assert item["hours_until_due"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        ("jobs", "due", "warning"),
        [(8, False, False), (9, False, True), (10, True, False), (13, True, False)],
    )
    async def test_warning_and_due_thresholds(
        self, async_client: AsyncClient, printer_factory, db_session, jobs, due, warning
    ):
        """Warn inside the last 10% of the interval, due at or past it."""
        printer = await printer_factory(name=f"Jobs Threshold {jobs}")
        type_id, _ = await _assign_jobs_task(async_client, printer, interval=10)
        await _set_jobs(db_session, printer, jobs)

        item = await _item(async_client, printer, type_id)

        assert (item["is_due"], item["is_warning"]) == (due, warning)
        assert (await _overview(async_client, printer))["total_print_jobs"] == jobs

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_hours_tasks_report_no_job_progress(self, async_client: AsyncClient, printer_factory, db_session):
        printer = await printer_factory(name="Hours Task Printer")
        await _set_jobs(db_session, printer, 7)

        overview = await _overview(async_client, printer)
        hours_item = next(i for i in overview["maintenance_items"] if i["interval_type"] == "hours")

        assert hours_item["current_jobs"] == 7
        assert hours_item["jobs_since_maintenance"] is None
        assert hours_item["jobs_until_due"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_printer_can_override_a_task_to_count_jobs(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Override Printer")
        await _set_jobs(db_session, printer, 3)
        overview = await _overview(async_client, printer)
        target = next(i for i in overview["maintenance_items"] if i["interval_type"] == "hours")

        patched = await async_client.patch(
            f"/api/v1/maintenance/items/{target['id']}",
            json={"custom_interval_type": "jobs", "custom_interval_hours": 5},
        )
        assert patched.status_code == 200

        item = await _item(async_client, printer, target["maintenance_type_id"])
        assert item["interval_type"] == "jobs"
        assert item["interval_hours"] == 5
        assert item["jobs_until_due"] == 2


class TestPerformResetsJobCount:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_perform_snapshots_jobs_and_restarts_the_count(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        printer = await printer_factory(name="Perform Jobs Printer")
        type_id, item_id = await _assign_jobs_task(async_client, printer, interval=10)
        await _set_jobs(db_session, printer, 12)
        assert (await _item(async_client, printer, type_id))["is_due"] is True

        performed = await async_client.post(f"/api/v1/maintenance/items/{item_id}/perform", json={"notes": "Swapped"})

        assert performed.status_code == 200
        body = performed.json()
        assert body["interval_type"] == "jobs"
        assert body["current_jobs"] == 12
        assert body["jobs_since_maintenance"] == 0
        assert body["jobs_until_due"] == 10
        assert body["is_due"] is False

        # The count is preserved on both the task history and the durable log.
        history = (await async_client.get(f"/api/v1/maintenance/items/{item_id}/history")).json()
        assert [h["jobs_at_maintenance"] for h in history] == [12]
        logs = (await async_client.get(f"/api/v1/maintenance/logs?printer_id={printer.id}&entry_type=scheduled")).json()
        assert [entry["jobs_at_maintenance"] for entry in logs["items"]] == [12]

        # Jobs after the service count from the snapshot, not from zero.
        await _set_jobs(db_session, printer, 15)
        item = await _item(async_client, printer, type_id)
        assert item["jobs_since_maintenance"] == 3
        assert item["jobs_until_due"] == 7
        assert item["is_due"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_manual_log_entries_do_not_invent_a_job_count(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="Manual Log Jobs Printer")

        created = await async_client.post(
            "/api/v1/maintenance/logs", json={"printer_id": printer.id, "title": "Replaced hotend"}
        )

        assert created.status_code == 200
        assert created.json()["jobs_at_maintenance"] is None


class TestIntervalTypeValidation:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_unknown_interval_type(self, async_client: AsyncClient):
        response = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Bad interval", "default_interval_hours": 10, "interval_type": "weeks"},
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_type_can_be_switched_to_jobs(self, async_client: AsyncClient):
        created = await async_client.post(
            "/api/v1/maintenance/types",
            json={"name": "Switch to jobs", "default_interval_hours": 100, "interval_type": "hours"},
        )
        assert created.status_code == 200

        updated = await async_client.patch(
            f"/api/v1/maintenance/types/{created.json()['id']}",
            json={"interval_type": "jobs", "default_interval_hours": 25},
        )

        assert updated.status_code == 200
        assert updated.json()["interval_type"] == "jobs"
        assert updated.json()["default_interval_hours"] == 25
