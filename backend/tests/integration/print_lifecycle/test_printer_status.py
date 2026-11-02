"""on_printer_status_change: what happens on each status push from a printer."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main
from backend.app.models.printer import Printer
from backend.app.services.bambu_mqtt import HMSError, PrinterState

pytestmark = pytest.mark.integration

# 0700_8010 is a documented AMS fault; descriptions come from the catalogue.
AMS_FAULT = HMSError(code="0x8010", attr=0x07000000, module=0x07, severity=2, description="AMS assist motor overloaded")


def _state(**kwargs) -> PrinterState:
    state = PrinterState()
    state.connected = True
    state.state = "RUNNING"
    for key, value in kwargs.items():
        setattr(state, key, value)
    return state


@pytest.fixture
def status(lifecycle):
    """Run the status handler without the full dict serialiser."""
    with (
        patch("backend.app.main.printer_state_to_dict", lambda state, *a: {"state": state.state}),
        patch("backend.app.main.reconcile_stale_active_prints", AsyncMock(return_value=0)),
    ):
        yield lifecycle


class TestBroadcasting:
    async def test_broadcasts_status_and_relays_to_mqtt(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(progress=10.0))

        status.ws.send_printer_status.assert_awaited_once_with(printer.id, {"state": "RUNNING"})
        status.relay.on_printer_status.assert_awaited_once()

    async def test_identical_status_is_not_rebroadcast(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(progress=10.0))
        await main.on_printer_status_change(printer.id, _state(progress=10.0))
        await main.on_printer_status_change(printer.id, _state(progress=11.0))

        assert status.ws.send_printer_status.await_count == 2
        # MQTT relay always publishes, even when nothing changed.
        assert status.relay.on_printer_status.await_count == 3


class TestProgressMilestones:
    async def test_notifies_each_milestone_once(self, status):
        printer = await status.make_printer()

        for progress in (10.0, 26.0, 30.0, 55.0, 80.0):
            await main.on_printer_status_change(
                printer.id, _state(progress=progress, subtask_name="Benchy", remaining_time=12)
            )

        milestones = [c.args[3] for c in status.notifications.on_print_progress.await_args_list]
        assert milestones == [25, 50, 75]
        first = status.notifications.on_print_progress.await_args_list[0]
        assert first.args[1] == "Lifecycle Printer"
        assert first.args[2] == "Benchy"
        assert first.args[5] == 12 * 60

    async def test_new_print_resets_milestones(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(progress=60.0))
        await main.on_printer_status_change(printer.id, _state(progress=0.0))
        await main.on_printer_status_change(printer.id, _state(progress=30.0))

        milestones = [c.args[3] for c in status.notifications.on_print_progress.await_args_list]
        assert milestones == [50, 25]


class TestHmsErrorNotifications:
    async def test_new_documented_error_is_notified_once(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(hms_errors=[AMS_FAULT], progress=1.0))
        await main.on_printer_status_change(printer.id, _state(hms_errors=[AMS_FAULT], progress=2.0))

        status.notifications.on_printer_error.assert_awaited_once()
        args = status.notifications.on_printer_error.await_args.args
        assert args[2] == "AMS/Filament Error"
        assert args[4] == "AMS assist motor overloaded"
        errors = status.relay.on_printer_error.await_args.args[3]
        assert errors == [{"code": "0x8010", "attr": 0x07000000, "module": 0x07, "severity": 2}]

    @pytest.mark.parametrize(
        "error",
        [
            # Undocumented codes are often phantom; they're not notified.
            HMSError(code="0x9999", attr=0x07000000, module=0x07, severity=2, description=None),
            # "Printing was cancelled" is a user action, not a fault.
            HMSError(code="0x400E", attr=0x05000000, module=0x05, severity=2, description="Printing was cancelled"),
            # Severity 1 is skipped: the H2D sends severity-1 camera status
            # messages that are not faults (6890c16e).
            HMSError(code="0x8010", attr=0x07000001, module=0x07, severity=1, description="Camera status"),
        ],
    )
    async def test_ignored_errors(self, status, error):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(hms_errors=[error]))

        status.notifications.on_printer_error.assert_not_awaited()

    async def test_error_clears_only_after_grace_period(self, status):
        printer = await status.make_printer()
        await main.on_printer_status_change(printer.id, _state(hms_errors=[AMS_FAULT], progress=1.0))

        # A brief gap in the error list doesn't re-arm the notification...
        await main.on_printer_status_change(printer.id, _state(hms_errors=[], progress=2.0))
        await main.on_printer_status_change(printer.id, _state(hms_errors=[AMS_FAULT], progress=3.0))
        assert status.notifications.on_printer_error.await_count == 1

        # ...but once the grace period has passed it does.
        main._hms_last_seen[printer.id] -= main._HMS_CLEAR_GRACE_SECONDS + 1
        await main.on_printer_status_change(printer.id, _state(hms_errors=[], progress=4.0))
        await main.on_printer_status_change(printer.id, _state(hms_errors=[AMS_FAULT], progress=5.0))
        assert status.notifications.on_printer_error.await_count == 2


async def test_detects_dual_nozzle_printer_from_temperatures(status):
    printer = await status.make_printer(nozzle_count=1)

    await main.on_printer_status_change(printer.id, _state(temperatures={"nozzle": 210, "nozzle_2": 25}))

    assert (await status.get(Printer, printer.id)).nozzle_count == 2


class TestReconnectReconciliation:
    async def test_idle_reconnect_reconciles_stale_archives_once(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(state="IDLE"))
        await main.on_printer_status_change(printer.id, _state(state="IDLE", progress=1.0))
        await status.drain()

        main.reconcile_stale_active_prints.assert_awaited_once_with(printer.id)

    async def test_waits_for_real_state_before_reconciling(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(state="unknown"))
        await status.drain()

        main.reconcile_stale_active_prints.assert_not_awaited()

    async def test_active_reconnect_defers_reconciliation(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(state="RUNNING"))
        await status.drain()

        main.reconcile_stale_active_prints.assert_not_awaited()
        assert printer.id in main._pending_stale_reconciliation

    async def test_disconnect_rearms_reconciliation(self, status):
        printer = await status.make_printer()

        await main.on_printer_status_change(printer.id, _state(state="IDLE"))
        await main.on_printer_status_change(printer.id, _state(state="IDLE", connected=False))
        await main.on_printer_status_change(printer.id, _state(state="IDLE", progress=2.0))
        await status.drain()

        assert main.reconcile_stale_active_prints.await_count == 2


class TestOfflineNotification:
    async def test_disconnect_schedules_offline_notification(self, status):
        printer = await status.make_printer()
        notify = AsyncMock()

        with patch("backend.app.main._maybe_notify_printer_offline", notify):
            await main.on_printer_status_change(printer.id, _state(state="IDLE"))
            await main.on_printer_status_change(printer.id, _state(state="IDLE", connected=False))
            await asyncio.sleep(0)

        notify.assert_awaited_once_with(printer.id)

    async def test_reconnect_cancels_pending_offline_notification(self, status):
        printer = await status.make_printer()

        async def never_finishes(_printer_id):
            await asyncio.Event().wait()

        with patch("backend.app.main._maybe_notify_printer_offline", never_finishes):
            await main.on_printer_status_change(printer.id, _state(state="IDLE"))
            await main.on_printer_status_change(printer.id, _state(state="IDLE", connected=False))
            pending = main._printer_offline_notify_tasks[printer.id]
            await main.on_printer_status_change(printer.id, _state(state="IDLE", progress=3.0))
            await asyncio.sleep(0)

        assert pending.cancelled()
        assert printer.id not in main._printer_offline_notify_tasks

    async def test_offline_notification_sent_if_still_offline_after_debounce(self, status):
        printer = await status.make_printer()
        status.printer_manager.is_connected.return_value = False

        with patch("backend.app.main.asyncio.sleep", AsyncMock()):
            await main._maybe_notify_printer_offline(printer.id)

        status.notifications.on_printer_offline.assert_awaited_once()

    async def test_no_offline_notification_if_back_online(self, status):
        printer = await status.make_printer()
        status.printer_manager.is_connected.return_value = True

        with patch("backend.app.main.asyncio.sleep", AsyncMock()):
            await main._maybe_notify_printer_offline(printer.id)

        status.notifications.on_printer_offline.assert_not_awaited()
