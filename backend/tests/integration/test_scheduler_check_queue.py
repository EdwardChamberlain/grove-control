"""PrintScheduler.check_queue against the real test database.

check_queue decides which pending queue items start now, and records a
waiting_reason for the rest. Uploads are recorded instead of run, and the
sub-steps with their own tests (AMS mapping, filament deficit, drying, heat
soak) are stubbed so each test isolates one dispatch decision.
"""

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.models.smart_plug import SmartPlug
from backend.app.services.print_scheduler import PrintScheduler

pytestmark = pytest.mark.integration


class Env:
    def __init__(self, session, scheduler):
        self.session = session
        self.scheduler = scheduler
        self.states: dict[int, dict] = {}
        self.notifications = AsyncMock()
        self.plugs = MagicMock()
        self.interlocks: dict[int, str] = {}

    def printer_state(self, printer_id, *, connected=True, state="IDLE", trays=()):
        tray_list = [{"id": str(i), "tray_type": t, "tray_color": c} for i, (t, c) in enumerate(trays)]
        self.states[printer_id] = {
            "connected": connected,
            "status": SimpleNamespace(state=state, raw_data={"ams": [{"id": "0", "tray": tray_list}], "vt_tray": []}),
        }

    def manager(self):
        pm = MagicMock()
        pm.is_connected.side_effect = lambda pid: self.states.get(pid, {}).get("connected", False)
        pm.get_status.side_effect = lambda pid: self.states.get(pid, {}).get("status")
        pm.is_awaiting_plate_clear.return_value = False
        return pm

    async def add(self, row):
        async with self.session() as db:
            db.add(row)
            await db.commit()
            await db.refresh(row)
        return row

    async def item(self, *, with_file=True, **kwargs):
        defaults = {"status": "pending", "position": 1, "force_color_match": False}
        if kwargs.get("target_model") and with_file and "library_file_id" not in kwargs:
            from backend.app.models.library import LibraryFile

            library_file = await self.add(
                LibraryFile(
                    filename="Benchy.gcode.3mf", file_path="library/Benchy.gcode.3mf", file_type="3mf", file_size=1
                )
            )
            defaults["library_file_id"] = library_file.id
        defaults.update(kwargs)
        return await self.add(PrintQueueItem(**defaults))

    async def get(self, item):
        async with self.session() as db:
            return await db.get(PrintQueueItem, item.id)

    async def run(self):
        await self.scheduler.check_queue()

    @property
    def dispatched(self) -> list[int]:
        return [i for call in self.scheduler._launch_uploads.call_args_list for i in call.args[0]]


@pytest.fixture
async def env(test_engine):
    session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    scheduler = PrintScheduler()
    e = Env(session, scheduler)
    ha = MagicMock(blocked_printers=AsyncMock(side_effect=lambda db: dict(e.interlocks)))
    with (
        patch("backend.app.services.print_scheduler.async_session", session),
        patch("backend.app.services.print_scheduler.printer_manager", e.manager()),
        patch("backend.app.services.print_scheduler.notification_service", e.notifications),
        patch("backend.app.services.print_scheduler.smart_plug_manager", e.plugs),
        patch("backend.app.services.print_scheduler.ha_sensor_manager", ha),
        patch.object(scheduler, "_launch_uploads", MagicMock()),
        patch.object(scheduler, "_check_heat_soaks", AsyncMock(return_value=set())),
        patch.object(scheduler, "_check_scheduled_dryings", AsyncMock()),
        patch.object(scheduler, "_check_auto_drying", AsyncMock()),
        patch.object(scheduler, "_compute_ams_mapping_for_printer", AsyncMock(return_value=[0])),
        patch.object(scheduler, "_block_on_filament_deficit", AsyncMock(return_value=False)),
        patch.object(scheduler, "_prepare_drying_for_dispatch", AsyncMock(return_value=True)),
    ):
        yield e


class TestPrinterTargetedJobs:
    async def test_idle_printer_gets_the_job(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id)
        item = await env.item(printer_id=printer.id)

        await env.run()

        assert env.dispatched == [item.id]
        assert json.loads((await env.get(item)).ams_mapping) == [0]

    async def test_future_and_manual_items_wait(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id)
        await env.item(printer_id=printer.id, scheduled_time=datetime.now(timezone.utc) + timedelta(hours=2))
        await env.item(printer_id=printer.id, manual_start=True, position=2)

        await env.run()

        assert env.dispatched == []

    async def test_due_scheduled_item_starts(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id)
        item = await env.item(
            printer_id=printer.id, scheduled_time=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)
        )

        await env.run()

        assert env.dispatched == [item.id]

    async def test_printer_with_active_job_is_reserved(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id)
        await env.item(printer_id=printer.id, status="printing")
        waiting = await env.item(printer_id=printer.id, position=2)

        await env.run()

        assert env.dispatched == []
        assert (await env.get(waiting)).waiting_reason == f"Waiting for printer reservation on printer {printer.id}"

    async def test_printing_printer_is_not_used(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id, state="RUNNING")
        item = await env.item(printer_id=printer.id)

        await env.run()

        assert env.dispatched == []
        assert (await env.get(item)).waiting_reason == f"Waiting for printer reservation on printer {printer.id}"

    async def test_home_assistant_interlock_holds_then_releases(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id)
        item = await env.item(printer_id=printer.id)
        env.interlocks[printer.id] = "Enclosure door open"

        await env.run()
        assert (await env.get(item)).waiting_reason == "Waiting on Enclosure door open"
        assert env.dispatched == []

        env.interlocks.clear()
        await env.run()
        assert (await env.get(item)).waiting_reason is None
        assert env.dispatched == [item.id]

    async def test_previous_failure_skips_job_and_notifies(self, env, printer_factory):
        printer = await printer_factory(name="Shop X1C")
        env.printer_state(printer.id)
        await env.item(printer_id=printer.id, status="failed", completed_at=datetime.now(timezone.utc))
        gated = await env.item(printer_id=printer.id, require_previous_success=True, position=2)

        await env.run()

        skipped = await env.get(gated)
        assert (skipped.status, skipped.error_message) == ("skipped", "Previous print failed or was aborted")
        assert env.notifications.on_queue_job_skipped.await_args.kwargs["printer_name"] == "Shop X1C"
        assert env.dispatched == []

    async def test_missing_material_holds_job(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id, trays=[("PLA", "FF0000FF")])
        item = await env.item(
            printer_id=printer.id, filament_overrides=json.dumps([{"slot_id": 1, "type": "PETG", "color": "#00FF00"}])
        )

        await env.run()

        assert (await env.get(item)).waiting_reason == "No matching material. Waiting on PETG"
        assert env.dispatched == []

    async def test_forced_colour_mismatch_holds_job(self, env, printer_factory):
        printer = await printer_factory()
        env.printer_state(printer.id, trays=[("PLA", "0000FFFF")])
        item = await env.item(
            printer_id=printer.id,
            force_color_match=True,
            filament_overrides=json.dumps([{"slot_id": 1, "type": "PLA", "color": "#FF0000", "color_name": "Red"}]),
        )

        with patch.object(env.scheduler, "_has_verifiable_filament_metadata", return_value=True):
            await env.run()

        assert "PLA (Red)" in (await env.get(item)).waiting_reason
        assert env.dispatched == []


class TestPowerOnOfflinePrinter:
    async def _offline_with_plugs(self, env, printer_factory, *plugs):
        printer = await printer_factory()
        env.printer_state(printer.id, connected=False)
        for name, kwargs in plugs:
            await env.add(
                SmartPlug(name=name, plug_type="tasmota", ip_address="10.0.0.9", printer_id=printer.id, **kwargs)
            )
        return printer

    async def test_powers_on_and_dispatches(self, env, printer_factory):
        printer = await self._offline_with_plugs(env, printer_factory, ("Printer", {}), ("Filter", {}))
        item = await env.item(printer_id=printer.id)
        extra_service = MagicMock(turn_on=AsyncMock())
        env.plugs.get_service_for_plug = AsyncMock(return_value=extra_service)

        async def power_on(plug, printer_id, db):
            env.printer_state(printer_id)
            return True

        with patch.object(env.scheduler, "_power_on_and_wait", AsyncMock(side_effect=power_on)):
            await env.run()

        assert env.dispatched == [item.id]
        extra_service.turn_on.assert_awaited_once()

    async def test_failed_power_on_leaves_job_pending(self, env, printer_factory):
        printer = await self._offline_with_plugs(env, printer_factory, ("Printer", {}))
        await env.item(printer_id=printer.id)

        with patch.object(env.scheduler, "_power_on_and_wait", AsyncMock(return_value=False)):
            await env.run()

        assert env.dispatched == []

    async def test_offline_without_auto_on_plug_waits(self, env, printer_factory):
        printer = await self._offline_with_plugs(env, printer_factory, ("Printer", {"auto_on": False}))
        await env.item(printer_id=printer.id)

        with patch.object(env.scheduler, "_power_on_and_wait", AsyncMock()) as power_on:
            await env.run()

        power_on.assert_not_awaited()
        assert env.dispatched == []


class TestModelTargetedJobs:
    async def test_assigns_an_idle_printer_and_notifies(self, env, printer_factory):
        printer = await printer_factory(name="Farm 1", model="P1S")
        env.printer_state(printer.id)
        item = await env.item(target_model="P1S")

        await env.run()

        assigned = await env.get(item)
        assert assigned.printer_id == printer.id
        assert assigned.waiting_reason is None
        assert env.dispatched == [item.id]
        kwargs = env.notifications.on_queue_job_assigned.await_args.kwargs
        assert (kwargs["printer_name"], kwargs["target_model"]) == ("Farm 1", "P1S")

    async def test_job_with_no_file_waits_with_explanation(self, env, printer_factory):
        env.printer_state((await printer_factory(model="P1S")).id)
        item = await env.item(target_model="P1S", with_file=False)

        await env.run()

        waiting = await env.get(item)
        assert waiting.printer_id is None
        assert waiting.waiting_reason.startswith("Every file for this job has been deleted")
        env.notifications.on_queue_job_waiting.assert_awaited_once()
        assert env.dispatched == []

    async def test_no_matching_printer_reports_why(self, env, printer_factory):
        busy = await printer_factory(name="Farm 1", model="P1S")
        env.printer_state(busy.id, state="RUNNING")
        item = await env.item(target_model="P1S")

        await env.run()

        assert (await env.get(item)).waiting_reason == "Busy: Farm 1"
        # All-busy needs no user action, so nobody is notified.
        env.notifications.on_queue_job_waiting.assert_not_awaited()

    async def test_second_job_waits_for_an_upload_slot(self, env, printer_factory):
        for name in ("Farm 1", "Farm 2"):
            env.printer_state((await printer_factory(name=name, model="P1S")).id)
        await env.add(Settings(key="queue_max_concurrent_uploads", value="1"))
        first = await env.item(target_model="P1S")
        second = await env.item(target_model="P1S", position=2)

        await env.run()

        assert env.dispatched == [first.id]
        assert (await env.get(second)).waiting_reason.startswith("Waiting for upload slot")

    async def test_previous_failure_on_chosen_printer_skips_job(self, env, printer_factory):
        printer = await printer_factory(model="P1S")
        env.printer_state(printer.id)
        await env.item(printer_id=printer.id, status="failed", completed_at=datetime.now(timezone.utc))
        gated = await env.item(target_model="P1S", require_previous_success=True, position=2)

        await env.run()

        assert (await env.get(gated)).status == "skipped"
        env.notifications.on_queue_job_skipped.assert_awaited_once()

    async def test_shortest_first_marks_jumped_items(self, env, printer_factory):
        env.printer_state((await printer_factory(model="P1S")).id)
        await env.add(Settings(key="queue_shortest_first", value="true"))
        long_job = await env.item(target_model="P1S", position=1, print_time_seconds=7200)
        short_job = await env.item(target_model="P1S", position=2, print_time_seconds=600)

        await env.run()

        assert env.dispatched == [short_job.id]
        # The skipped-over job is protected from being jumped again.
        assert (await env.get(long_job)).been_jumped is True
