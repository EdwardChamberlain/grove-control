"""Door open→close marks the plate clear (#238).

Two layers:
  * ``PrinterManager.observe_door_state`` — edge tracking. Reports a cycle
    when the door opens after printing stops and then closes while the
    printer is awaiting plate-clear. ``_on_mqtt_state_change`` feeds it
    door values copied at push time.
  * ``PrinterManager._clear_plate_after_door_cycle`` — clears the gate only
    when the ``door_cycle_clears_plate`` setting is enabled.
"""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.printer_manager import PrinterManager

PID = 7


@pytest.fixture
def pm() -> PrinterManager:
    # No event loop attached, so set_awaiting_plate_clear stays in memory.
    return PrinterManager()


class TestObserveDoorState:
    def test_open_then_close_while_awaiting_reports_cycle(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        assert pm.observe_door_state(PID, False) is False  # first observation
        assert pm.observe_door_state(PID, True) is False  # opened
        assert pm.observe_door_state(PID, False) is True  # closed → cycle

    def test_cycle_reported_only_once(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        pm.observe_door_state(PID, False)
        pm.observe_door_state(PID, True)
        assert pm.observe_door_state(PID, False) is True
        assert pm.observe_door_state(PID, False) is False

    def test_repeated_open_updates_do_not_report(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        pm.observe_door_state(PID, False)
        assert pm.observe_door_state(PID, True) is False
        assert pm.observe_door_state(PID, True) is False

    def test_not_awaiting_never_reports(self, pm):
        pm.observe_door_state(PID, False)
        pm.observe_door_state(PID, True)
        assert pm.observe_door_state(PID, False) is False

    def test_door_opened_during_print_does_not_count(self, pm):
        # Door opened mid-print; print finishes; door then closes.
        pm.observe_door_state(PID, False, printing=True)
        pm.observe_door_state(PID, True, printing=True)
        pm.observe_door_state(PID, True, printing=False)  # FINISH push, door still open
        pm.set_awaiting_plate_clear(PID, True)
        assert pm.observe_door_state(PID, False) is False
        # A fresh open→close after the print does count.
        pm.observe_door_state(PID, True)
        assert pm.observe_door_state(PID, False) is True

    def test_door_opened_before_gate_raised_counts(self, pm):
        # The door opens in the moment between FINISH and the gate being set.
        pm.observe_door_state(PID, False, printing=True)
        pm.observe_door_state(PID, False)  # FINISH
        pm.observe_door_state(PID, True)  # opened before on_print_complete ran
        pm.set_awaiting_plate_clear(PID, True)
        assert pm.observe_door_state(PID, False) is True

    def test_close_seen_as_first_observation_does_not_count(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        assert pm.observe_door_state(PID, False) is False

    def test_reset_forgets_open_door(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        pm.observe_door_state(PID, False)
        pm.observe_door_state(PID, True)
        pm.reset_door_tracking(PID)  # e.g. disconnect
        assert pm.observe_door_state(PID, False) is False

    def test_manual_clear_disarms_pending_open(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        pm.observe_door_state(PID, False)
        pm.observe_door_state(PID, True)
        pm.set_awaiting_plate_clear(PID, False)  # user clicked "plate cleared"
        pm.set_awaiting_plate_clear(PID, True)  # next print finishes
        assert pm.observe_door_state(PID, False) is False

    def test_printers_tracked_independently(self, pm):
        pm.set_awaiting_plate_clear(1, True)
        pm.set_awaiting_plate_clear(2, True)
        pm.observe_door_state(1, False)
        pm.observe_door_state(2, False)
        pm.observe_door_state(1, True)
        assert pm.observe_door_state(2, False) is False
        assert pm.observe_door_state(1, False) is True


def _state(door_open: bool, connected: bool = True, state: str = "FINISH") -> SimpleNamespace:
    return SimpleNamespace(connected=connected, door_open=door_open, state=state)


async def _drain() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


class TestMqttStateChangeWiring:
    """``_on_mqtt_state_change`` is what the MQTT client's state callback calls."""

    @pytest.fixture
    async def wired(self, pm):
        pm.set_event_loop(asyncio.get_running_loop())
        clear = AsyncMock()
        with (
            patch.object(pm, "_broadcast_status_change", new=AsyncMock()),
            patch.object(pm, "_persist_awaiting_plate_clear", new=AsyncMock()),
            patch.object(pm, "_clear_plate_after_door_cycle", new=clear),
        ):
            pm.set_awaiting_plate_clear(PID, True)
            yield pm, clear

    @pytest.mark.asyncio
    async def test_cycle_clears_plate(self, wired):
        pm, clear = wired
        for door in (False, True, False):
            pm._on_mqtt_state_change(PID, _state(door))
        await _drain()
        clear.assert_awaited_once_with(PID)

    @pytest.mark.asyncio
    async def test_uses_door_value_at_push_time(self, wired):
        # One live state object, mutated between pushes before the loop runs.
        pm, clear = wired
        live = _state(False)
        pm._on_mqtt_state_change(PID, live)
        live.door_open = True
        pm._on_mqtt_state_change(PID, live)
        live.door_open = False
        pm._on_mqtt_state_change(PID, live)
        await _drain()
        clear.assert_awaited_once_with(PID)

    @pytest.mark.asyncio
    async def test_unchanged_pushes_queue_no_door_update(self, wired):
        pm, _ = wired
        with patch.object(pm, "_handle_door_update", new=AsyncMock()) as handle:
            for _ in range(5):
                pm._on_mqtt_state_change(PID, _state(False))
            pm._on_mqtt_state_change(PID, _state(False, state="RUNNING"))
            pm._on_mqtt_state_change(PID, _state(True, state="RUNNING"))
            await _drain()
        assert handle.await_count == 3

    @pytest.mark.asyncio
    async def test_disconnect_resets_tracking(self, wired):
        pm, clear = wired
        pm._on_mqtt_state_change(PID, _state(False))
        pm._on_mqtt_state_change(PID, _state(True))
        pm._on_mqtt_state_change(PID, _state(True, connected=False))
        pm._on_mqtt_state_change(PID, _state(False))
        await _drain()
        clear.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_power_off_reset_runs_after_queued_updates(self, wired):
        # Door updates are still queued when the smart plug cuts power. The
        # reset must run after them, or they re-seed the tracking.
        pm, clear = wired
        client = MagicMock()
        client.mark_power_off.return_value = True
        pm._clients[PID] = client
        pm._on_mqtt_state_change(PID, _state(False))
        pm._on_mqtt_state_change(PID, _state(True))
        pm.mark_printer_offline(PID)
        await _drain()
        pm._on_mqtt_state_change(PID, _state(False))  # power back, door closed
        await _drain()
        clear.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_disconnect_printer_reset_runs_after_queued_updates(self, wired):
        pm, clear = wired
        pm._clients[PID] = MagicMock()
        pm._on_mqtt_state_change(PID, _state(False))
        pm._on_mqtt_state_change(PID, _state(True))
        pm.disconnect_printer(PID)
        await _drain()
        pm._on_mqtt_state_change(PID, _state(False))  # reconnected, door closed
        await _drain()
        clear.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_status_change_callback_still_called(self, wired):
        pm, _ = wired
        status_cb = AsyncMock()
        pm.set_status_change_callback(status_cb)
        st = _state(False)
        pm._on_mqtt_state_change(PID, st)
        await _drain()
        status_cb.assert_awaited_once_with(PID, st)


class TestClearPlateAfterDoorCycle:
    @pytest.mark.asyncio
    async def test_clears_gate_when_enabled(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        with patch.object(pm, "_door_cycle_setting_enabled", new=AsyncMock(return_value=True)):
            await pm._clear_plate_after_door_cycle(PID)
        assert pm.is_awaiting_plate_clear(PID) is False

    @pytest.mark.asyncio
    async def test_leaves_gate_when_disabled(self, pm):
        pm.set_awaiting_plate_clear(PID, True)
        with patch.object(pm, "_door_cycle_setting_enabled", new=AsyncMock(return_value=False)):
            await pm._clear_plate_after_door_cycle(PID)
        assert pm.is_awaiting_plate_clear(PID) is True

    @pytest.mark.asyncio
    async def test_skips_if_gate_already_cleared(self, pm):
        with (
            patch.object(pm, "_door_cycle_setting_enabled", new=AsyncMock(return_value=True)),
            patch.object(pm, "set_awaiting_plate_clear") as set_gate,
        ):
            await pm._clear_plate_after_door_cycle(PID)
        set_gate.assert_not_called()


def _session_returning(value=None, error: Exception | None = None):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    db = MagicMock()
    db.execute = AsyncMock(return_value=result, side_effect=error)

    @asynccontextmanager
    async def _session():
        yield db

    return _session


class TestDoorCycleSettingEnabled:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("value", "expected"),
        [("true", True), ("True", True), ("false", False), ("", False), (None, False)],
    )
    async def test_reads_setting(self, pm, value, expected):
        with patch("backend.app.core.database.async_session", _session_returning(value)):
            assert await pm._door_cycle_setting_enabled() is expected

    @pytest.mark.asyncio
    async def test_read_failure_counts_as_disabled(self, pm):
        with patch("backend.app.core.database.async_session", _session_returning(error=RuntimeError("db"))):
            assert await pm._door_cycle_setting_enabled() is False
