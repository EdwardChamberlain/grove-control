"""Door open→close marks the plate clear (#238).

Two layers:
  * ``PrinterManager.observe_door_state`` — edge tracking. Reports a cycle
    only when the door opens and then closes while the printer is awaiting
    plate-clear.
  * ``main._maybe_clear_plate_from_door_cycle`` — clears the gate only when
    the ``door_cycle_clears_plate`` setting is enabled.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app import main as main_module
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

    def test_door_opened_before_gate_raised_does_not_count(self, pm):
        # Door opened during the print; print finishes; door then closes.
        pm.observe_door_state(PID, False)
        pm.observe_door_state(PID, True)
        pm.set_awaiting_plate_clear(PID, True)
        assert pm.observe_door_state(PID, False) is False
        # A fresh open→close after the gate is raised does count.
        pm.observe_door_state(PID, True)
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


def _session_factory():
    @asynccontextmanager
    async def _session():
        yield MagicMock()

    return _session


class TestMaybeClearPlateFromDoorCycle:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("value", ["true", "True"])
    async def test_clears_gate_when_enabled(self, value):
        with (
            patch("backend.app.main.async_session", _session_factory()),
            patch("backend.app.api.routes.settings.get_setting", new=AsyncMock(return_value=value)),
            patch("backend.app.main.printer_manager") as mock_pm,
        ):
            mock_pm.is_awaiting_plate_clear.return_value = True
            await main_module._maybe_clear_plate_from_door_cycle(PID)
            mock_pm.set_awaiting_plate_clear.assert_called_once_with(PID, False)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("value", [None, "false", ""])
    async def test_leaves_gate_when_disabled(self, value):
        with (
            patch("backend.app.main.async_session", _session_factory()),
            patch("backend.app.api.routes.settings.get_setting", new=AsyncMock(return_value=value)),
            patch("backend.app.main.printer_manager") as mock_pm,
        ):
            mock_pm.is_awaiting_plate_clear.return_value = True
            await main_module._maybe_clear_plate_from_door_cycle(PID)
            mock_pm.set_awaiting_plate_clear.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_if_gate_already_cleared(self):
        with (
            patch("backend.app.main.async_session", _session_factory()),
            patch("backend.app.api.routes.settings.get_setting", new=AsyncMock(return_value="true")),
            patch("backend.app.main.printer_manager") as mock_pm,
        ):
            mock_pm.is_awaiting_plate_clear.return_value = False
            await main_module._maybe_clear_plate_from_door_cycle(PID)
            mock_pm.set_awaiting_plate_clear.assert_not_called()

    @pytest.mark.asyncio
    async def test_setting_read_failure_leaves_gate(self):
        with (
            patch("backend.app.main.async_session", _session_factory()),
            patch("backend.app.api.routes.settings.get_setting", new=AsyncMock(side_effect=RuntimeError("db"))),
            patch("backend.app.main.printer_manager") as mock_pm,
        ):
            mock_pm.is_awaiting_plate_clear.return_value = True
            await main_module._maybe_clear_plate_from_door_cycle(PID)
            mock_pm.set_awaiting_plate_clear.assert_not_called()
