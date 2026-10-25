"""Regression tests for the previous-success gate on model-targeted jobs."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.print_queue import PrintQueueItem
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
                    filename="Benchy.gcode.3mf",
                    file_path="library/Benchy.gcode.3mf",
                    file_type="3mf",
                    file_size=1,
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
        return [item_id for call in self.scheduler._launch_uploads.call_args_list for item_id in call.args[0]]


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


@pytest.mark.parametrize("previous_status", ["failed", "aborted"])
async def test_model_target_is_skipped_after_failed_predecessor(env, printer_factory, previous_status):
    printer = await printer_factory(model="P1S")
    env.printer_state(printer.id)
    await env.item(printer_id=printer.id, status=previous_status, completed_at=datetime.now(timezone.utc))
    gated = await env.item(target_model="P1S", require_previous_success=True, position=2)

    await env.run()

    skipped = await env.get(gated)
    assert skipped.status == "skipped"
    assert env.dispatched == []
    env.notifications.on_queue_job_skipped.assert_awaited_once()


@pytest.mark.parametrize("previous_status", [None, "completed"])
async def test_model_target_dispatches_after_success_or_without_predecessor(env, printer_factory, previous_status):
    printer = await printer_factory(model="P1S")
    env.printer_state(printer.id)
    if previous_status:
        await env.item(printer_id=printer.id, status=previous_status, completed_at=datetime.now(timezone.utc))
    gated = await env.item(target_model="P1S", require_previous_success=True, position=2)

    await env.run()

    assert (await env.get(gated)).status == "pending"
    assert env.dispatched == [gated.id]
