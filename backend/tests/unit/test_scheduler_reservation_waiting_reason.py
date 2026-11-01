"""Reservation waits identify the assigned printer by its friendly name (#288)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler


@pytest.mark.parametrize("shortest_first", [False, True])
@pytest.mark.parametrize("reserved_status", ["preheating", "dispatching", "printing", None])
@pytest.mark.asyncio
async def test_reservation_wait_uses_current_printer_name(test_engine, shortest_first, reserved_status):
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as db:
        db.add(
            Printer(
                id=3,
                name="Workshop H2D",
                serial_number="H2D0003",
                ip_address="10.0.0.3",
                access_code="test",
                model="H2D",
            )
        )
        item = PrintQueueItem(printer_id=3, position=1, status="pending", force_color_match=False)
        db.add(item)
        if reserved_status:
            db.add(PrintQueueItem(printer_id=3, position=0, status=reserved_status))
        await db.commit()
        item_id = item.id

    scheduler = PrintScheduler()

    async def bool_setting(_db, key, default=False):
        return shortest_first if key == "queue_shortest_first" else default

    with (
        patch("backend.app.services.print_scheduler.async_session", session_maker),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", return_value=True),
        patch("backend.app.services.print_scheduler.printer_manager.get_status", return_value=None),
        patch("backend.app.services.print_scheduler.ha_sensor_manager.blocked_printers", AsyncMock(return_value={})),
        patch.object(scheduler, "_get_bool_setting", side_effect=bool_setting),
        patch.object(scheduler, "_recover_stale_dispatches", AsyncMock()),
        patch.object(scheduler, "_check_heat_soaks", AsyncMock(return_value=set())),
        patch.object(scheduler, "_check_scheduled_dryings", AsyncMock()),
        patch.object(scheduler, "_check_auto_drying", AsyncMock()),
        patch.object(scheduler, "_is_printer_idle", return_value=reserved_status is not None),
        patch.object(scheduler, "_launch_uploads", MagicMock()) as launched,
    ):
        await scheduler.check_queue()

        launched.assert_not_called()
        async with session_maker() as db:
            waiting = await db.get(PrintQueueItem, item_id)
            assert waiting.status == "pending"
            assert waiting.waiting_reason == "Waiting for printer reservation on Workshop H2D"
            assert waiting.error_message is None

            # Persisted wait messages should also follow later printer renames.
            printer = await db.get(Printer, 3)
            printer.name = "Studio H2D"
            await db.commit()

        await scheduler.check_queue()

        launched.assert_not_called()
        async with session_maker() as db:
            waiting = await db.get(PrintQueueItem, item_id)
            assert waiting.status == "pending"
            assert waiting.waiting_reason == "Waiting for printer reservation on Studio H2D"
