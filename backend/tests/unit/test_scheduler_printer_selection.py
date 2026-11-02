"""PrintScheduler printer selection and power-on.

_find_idle_printer_for_model picks which printer a model-targeted queue job
goes to, and explains in waiting_reason why nothing was picked. These tests
drive it with a fake fleet: each printer's connection, state and loaded spools.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.print_scheduler import PrintScheduler


class Fleet:
    """Stands in for printer_manager with per-printer connection and state."""

    def __init__(self):
        self.printers: dict[int, dict] = {}

    def add(self, printer_id, *, connected=True, state="IDLE", trays=(), external=(), plate_clear_pending=False):
        ams = [{"id": "0", "tray": [{"id": str(i), "tray_type": t, "tray_color": c} for i, (t, c) in enumerate(trays)]}]
        vt = [{"id": "254", "tray_type": t, "tray_color": c} for t, c in external]
        self.printers[printer_id] = {
            "connected": connected,
            "status": SimpleNamespace(state=state, raw_data={"ams": ams, "vt_tray": vt}),
            "plate": plate_clear_pending,
        }

    def manager(self):
        pm = MagicMock()
        pm.is_connected.side_effect = lambda pid: self.printers.get(pid, {}).get("connected", False)
        pm.get_status.side_effect = lambda pid: self.printers.get(pid, {}).get("status")
        pm.is_awaiting_plate_clear.side_effect = lambda pid: self.printers.get(pid, {}).get("plate", False)
        return pm


@pytest.fixture
def fleet():
    f = Fleet()
    with patch("backend.app.services.print_scheduler.printer_manager", f.manager()):
        yield f


@pytest.fixture
def scheduler():
    return PrintScheduler()


async def _find(scheduler, db, model="X1C", exclude=(), **kwargs):
    return await scheduler._find_idle_printer_for_model(db, model, set(exclude), **kwargs)


RED = "FF0000FF"
BLUE = "0000FFFF"
RED_PLA = {"type": "PLA", "color": "#FF0000", "color_name": "Red", "force_color_match": True}


class TestFindIdlePrinter:
    async def test_no_printers_of_that_model(self, scheduler, fleet, db_session):
        assert await _find(scheduler, db_session, "H2D") == (None, "No active H2D printers configured")

    async def test_location_filter(self, scheduler, fleet, db_session, printer_factory):
        await printer_factory(name="Shed", location="Shed")
        office = await printer_factory(name="Office", location="Office")
        fleet.add(office.id)

        assert await _find(scheduler, db_session, target_location="Office") == (office.id, None)
        assert await _find(scheduler, db_session, target_location="Loft") == (
            None,
            "No active X1C printers in Loft configured",
        )

    async def test_first_idle_printer_wins(self, scheduler, fleet, db_session, printer_factory):
        busy = await printer_factory(name="Busy")
        idle = await printer_factory(name="Idle")
        fleet.add(busy.id, state="RUNNING")
        fleet.add(idle.id, state="FINISH")

        assert await _find(scheduler, db_session) == (idle.id, None)

    async def test_reasons_list_busy_offline_and_claimed(self, scheduler, fleet, db_session, printer_factory):
        claimed = await printer_factory(name="Claimed")
        busy = await printer_factory(name="Printing")
        offline = await printer_factory(name="Unplugged")
        gated = await printer_factory(name="Dirty plate")
        fleet.add(claimed.id)
        fleet.add(busy.id, state="RUNNING")
        fleet.add(offline.id, connected=False)
        fleet.add(gated.id, plate_clear_pending=True)

        printer_id, reason = await _find(scheduler, db_session, exclude={claimed.id})

        assert printer_id is None
        assert reason == "Busy: Claimed, Printing, Dirty plate | Offline: Unplugged"

    async def test_plate_gate_can_be_bypassed(self, scheduler, fleet, db_session, printer_factory):
        gated = await printer_factory()
        fleet.add(gated.id, plate_clear_pending=True)

        assert await _find(scheduler, db_session, require_plate_clear=False) == (gated.id, None)

    async def test_required_filament_types(self, scheduler, fleet, db_session, printer_factory):
        pla_only = await printer_factory(name="PLA only")
        both = await printer_factory(name="Both")
        fleet.add(pla_only.id, trays=[("PLA", RED)])
        fleet.add(both.id, trays=[("PLA", RED)], external=[("PETG", BLUE)])

        assert await _find(scheduler, db_session, required_filament_types=["PLA", "PETG"]) == (both.id, None)

    async def test_missing_filament_reason(self, scheduler, fleet, db_session, printer_factory):
        printer = await printer_factory(name="P1")
        fleet.add(printer.id, trays=[("PLA", RED)])

        assert await _find(scheduler, db_session, required_filament_types=["PETG", "PLA"]) == (
            None,
            "Waiting for filament: P1 (needs PETG)",
        )

    async def test_unknown_status_counts_every_type_missing(self, scheduler, fleet, db_session, printer_factory):
        printer = await printer_factory(name="P1")
        fleet.add(printer.id)
        fleet.printers[printer.id]["status"] = None

        printer_id, reason = await _find(scheduler, db_session, required_filament_types=["PLA"])

        # No status also means "not idle", so it reads as busy.
        assert (printer_id, reason) == (None, "Busy: P1")

    async def test_force_color_requires_exact_type_and_colour(self, scheduler, fleet, db_session, printer_factory):
        blue = await printer_factory(name="Blue")
        red = await printer_factory(name="Red")
        fleet.add(blue.id, trays=[("PLA", BLUE)])
        fleet.add(red.id, trays=[("PLA", RED)])

        assert await _find(scheduler, db_session, filament_overrides=[RED_PLA]) == (red.id, None)

    async def test_force_color_mismatch_reason(self, scheduler, fleet, db_session, printer_factory):
        blue = await printer_factory(name="Blue")
        fleet.add(blue.id, trays=[("PLA", BLUE)])

        assert await _find(scheduler, db_session, filament_overrides=[RED_PLA]) == (
            None,
            "No matching material/colour. Waiting on PLA (Red)",
        )

    async def test_force_color_reports_busy_printer_with_wrong_colour_as_mismatch(
        self, scheduler, fleet, db_session, printer_factory
    ):
        busy_blue = await printer_factory(name="Busy blue")
        claimed_blue = await printer_factory(name="Claimed blue")
        fleet.add(busy_blue.id, state="RUNNING", trays=[("PLA", BLUE)])
        fleet.add(claimed_blue.id, trays=[("PLA", BLUE)])

        _, reason = await _find(scheduler, db_session, exclude={claimed_blue.id}, filament_overrides=[RED_PLA])

        assert reason == "No matching material/colour. Waiting on PLA (Red)"

    async def test_force_color_prefers_busy_message_when_right_colour_is_busy(
        self, scheduler, fleet, db_session, printer_factory
    ):
        busy_red = await printer_factory(name="Busy red")
        idle_blue = await printer_factory(name="Idle blue")
        fleet.add(busy_red.id, state="RUNNING", trays=[("PLA", RED)])
        fleet.add(idle_blue.id, trays=[("PLA", BLUE)])

        _, reason = await _find(scheduler, db_session, filament_overrides=[RED_PLA])

        # The job will start by itself once the red printer is free.
        assert reason == "Busy: Busy red"

    async def test_force_color_enriches_missing_type_message(self, scheduler, fleet, db_session, printer_factory):
        printer = await printer_factory(name="P1")
        fleet.add(printer.id, trays=[("PETG", RED)])

        _, reason = await _find(
            scheduler, db_session, required_filament_types=["PLA"], filament_overrides=[RED_PLA, {"type": "TPU"}]
        )

        assert reason == "Waiting for filament: P1 (needs PLA (Red))"

    async def test_colour_preference_ranks_exact_matches_first(self, scheduler, fleet, db_session, printer_factory):
        blue = await printer_factory(name="Blue")
        red = await printer_factory(name="Red")
        fleet.add(blue.id, trays=[("PLA", BLUE)])
        fleet.add(red.id, trays=[("PLA", RED)])

        preference = {"type": "PLA", "color": "#FF0000"}
        assert await _find(scheduler, db_session, filament_overrides=[preference]) == (red.id, None)


class TestPowerOnAndWait:
    @pytest.fixture
    def plug(self):
        return SimpleNamespace(name="Printer plug")

    @pytest.fixture
    def service(self):
        svc = MagicMock()
        svc.get_status = AsyncMock(return_value={"reachable": True, "state": "OFF"})
        svc.turn_on = AsyncMock(return_value=True)
        return svc

    @pytest.fixture
    def env(self, service):
        plugs = MagicMock(get_service_for_plug=AsyncMock(return_value=service))
        pm = MagicMock(connect_printer=AsyncMock(return_value=True))
        with (
            patch("backend.app.services.print_scheduler.smart_plug_manager", plugs),
            patch("backend.app.services.print_scheduler.printer_manager", pm),
            patch("backend.app.services.print_scheduler.asyncio.sleep", AsyncMock()),
        ):
            yield pm

    async def test_turns_plug_on_and_waits_for_connection(
        self, scheduler, service, env, plug, db_session, printer_factory
    ):
        printer = await printer_factory()

        assert await scheduler._power_on_and_wait(plug, printer.id, db_session) is True

        service.turn_on.assert_awaited_once_with(plug)
        assert env.connect_printer.await_args.args[0].id == printer.id

    async def test_plug_already_on_is_not_switched(self, scheduler, service, env, plug, db_session, printer_factory):
        printer = await printer_factory()
        service.get_status.return_value = {"reachable": True, "state": "ON"}

        assert await scheduler._power_on_and_wait(plug, printer.id, db_session) is True
        service.turn_on.assert_not_awaited()

    @pytest.mark.parametrize(
        ("status", "turn_on"),
        [({"reachable": False}, True), ({"reachable": True, "state": "OFF"}, False)],
    )
    async def test_unreachable_or_failed_plug(self, scheduler, service, env, plug, db_session, status, turn_on):
        service.get_status.return_value = status
        service.turn_on.return_value = turn_on

        assert await scheduler._power_on_and_wait(plug, 1, db_session) is False
        env.connect_printer.assert_not_awaited()

    async def test_missing_printer(self, scheduler, env, plug, db_session):
        assert await scheduler._power_on_and_wait(plug, 4242, db_session) is False

    async def test_gives_up_when_printer_never_connects(self, scheduler, env, plug, db_session, printer_factory):
        printer = await printer_factory()
        env.connect_printer.side_effect = [ConnectionError("refused"), False, False, False]
        scheduler._power_on_wait_time = 70
        scheduler._power_on_check_interval = 10

        assert await scheduler._power_on_and_wait(plug, printer.id, db_session) is False
        assert env.connect_printer.await_count == 4
