"""on_ams_change: keeping spool assignments in step with what's in the AMS."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app import main
from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment

pytestmark = pytest.mark.integration

BL_UUID = "A1B2C3D4E5F60718293A4B5C6D7E8F90"
OTHER_BL_UUID = "0F1E2D3C4B5A69788796A5B4C3D2E1F0"


def _ams(*trays, ams_id=0):
    return [{"id": str(ams_id), "tray": list(trays)}]


def _tray(tray_id=0, **kwargs):
    tray = {"id": str(tray_id), "tray_type": "PLA", "tray_color": "FF0000FF", "tag_uid": "", "tray_uuid": ""}
    tray.update(kwargs)
    return tray


@pytest.fixture
def ams(lifecycle):
    with patch("backend.app.main.printer_state_to_dict", lambda state, *a: {"state": state.state}):
        lifecycle.printer_manager.get_status.return_value = SimpleNamespace(state="IDLE", raw_data={})
        yield lifecycle


async def _assign(env, printer, *, ams_id=0, tray_id=0, fp_color="FF0000FF", fp_type="PLA", **spool_kwargs):
    spool_defaults = {"material": "PLA", "rgba": "FF0000FF", "label_weight": 1000, "weight_used": 0}
    spool_defaults.update(spool_kwargs)
    spool = await env.add(Spool(**spool_defaults))
    assignment = await env.add(
        SpoolAssignment(
            spool_id=spool.id,
            printer_id=printer.id,
            ams_id=ams_id,
            tray_id=tray_id,
            fingerprint_color=fp_color,
            fingerprint_type=fp_type,
        )
    )
    return spool, assignment


def _assignment_changes(env):
    return [c.args[0] for c in env.ws.broadcast.await_args_list if c.args[0]["type"] == "spool_assignment_changed"]


async def test_broadcasts_status_and_relays_ams_data(ams):
    printer = await ams.make_printer()
    data = _ams(_tray())

    await main.on_ams_change(printer.id, data)

    ams.ws.send_printer_status.assert_awaited_once()
    assert ams.relay.on_ams_change.await_args.args[3] == data


class TestStaleAssignmentCleanup:
    async def test_empty_slot_unlinks_spool(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, tray_id=1)

        await main.on_ams_change(printer.id, _ams(_tray(0)))

        assert await ams.all(SpoolAssignment) == []
        assert _assignment_changes(ams) == [
            {"type": "spool_assignment_changed", "printer_id": printer.id, "ams_id": 0, "tray_id": 1}
        ]

    async def test_empty_slot_during_print_keeps_spool(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, tray_id=1)
        ams.printer_manager.get_status.return_value = SimpleNamespace(state="RUNNING", raw_data={})

        await main.on_ams_change(printer.id, _ams(_tray(0)))

        assert len(await ams.all(SpoolAssignment)) == 1

    async def test_same_bambu_spool_keeps_assignment_and_refreshes_fingerprint(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, tray_uuid=BL_UUID, fp_color="000000FF")

        await main.on_ams_change(printer.id, _ams(_tray(tray_uuid=BL_UUID, tray_color="00FF00FF")))

        [kept] = await ams.all(SpoolAssignment)
        assert kept.fingerprint_color == "00FF00FF"

    async def test_different_bambu_spool_unlinks(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, tray_uuid=BL_UUID)

        with patch("backend.app.services.spool_tag_matcher.auto_assign_spool", AsyncMock()):
            await main.on_ams_change(printer.id, _ams(_tray(tray_uuid=OTHER_BL_UUID)))

        assert [a.spool_id for a in await ams.all(SpoolAssignment)] == []

    async def test_changed_generic_filament_unlinks(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer)

        await main.on_ams_change(printer.id, _ams(_tray(tray_type="PETG", tray_color="0000FFFF")))

        assert await ams.all(SpoolAssignment) == []

    async def test_fingerprint_mismatch_but_tray_matches_spool_updates_fingerprint(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, fp_color="000000FF", fp_type="ABS", rgba="FF0000FF", material="PLA")

        await main.on_ams_change(printer.id, _ams(_tray()))

        [kept] = await ams.all(SpoolAssignment)
        assert (kept.fingerprint_color, kept.fingerprint_type) == ("FF0000FF", "PLA")

    async def test_tray_cleared_by_runout_during_print_keeps_spool(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer)
        ams.printer_manager.get_status.return_value = SimpleNamespace(state="RUNNING", raw_data={})

        await main.on_ams_change(printer.id, _ams(_tray(tray_type="", tray_color="", state=3)))

        assert len(await ams.all(SpoolAssignment)) == 1

    async def test_preassigned_spool_is_configured_when_filament_is_inserted(self, ams):
        printer = await ams.make_printer()
        spool, _ = await _assign(ams, printer, fp_color="", fp_type="")
        apply = AsyncMock()

        with patch("backend.app.api.routes.inventory.apply_spool_to_slot_via_mqtt", apply):
            await main.on_ams_change(printer.id, _ams(_tray(state=11, tray_info_idx="GFA00")))

        assert apply.await_args.kwargs["spool"].id == spool.id
        assert apply.await_args.kwargs["current_tray_info_idx"] == "GFA00"
        [kept] = await ams.all(SpoolAssignment)
        assert kept.fingerprint_type == "PLA"

    async def test_external_spool_kept_until_vt_tray_reports(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, ams_id=255, tray_id=0)

        await main.on_ams_change(printer.id, _ams(_tray()))

        assert len(await ams.all(SpoolAssignment)) == 1

    async def test_external_spool_change_unlinks(self, ams):
        printer = await ams.make_printer()
        await _assign(ams, printer, ams_id=255, tray_id=0)
        ams.printer_manager.get_status.return_value = SimpleNamespace(
            state="IDLE", raw_data={"vt_tray": [{"id": "254", "tray_type": "TPU", "tray_color": "FFFFFFFF"}]}
        )

        await main.on_ams_change(printer.id, _ams(_tray()))

        assert await ams.all(SpoolAssignment) == []


class TestWeightSyncFromRemain:
    async def test_remain_percentage_raises_weight_used(self, ams):
        printer = await ams.make_printer()
        spool, _ = await _assign(ams, printer, weight_used=100)

        await main.on_ams_change(printer.id, _ams(_tray(remain=40)))

        assert (await ams.get(Spool, spool.id)).weight_used == 600.0

    async def test_never_lowers_weight_used(self, ams):
        printer = await ams.make_printer()
        spool, _ = await _assign(ams, printer, weight_used=700)

        await main.on_ams_change(printer.id, _ams(_tray(remain=40)))

        assert (await ams.get(Spool, spool.id)).weight_used == 700

    async def test_locked_spool_is_not_synced(self, ams):
        printer = await ams.make_printer()
        spool, _ = await _assign(ams, printer, weight_used=100, weight_locked=True)

        await main.on_ams_change(printer.id, _ams(_tray(remain=40)))

        assert (await ams.get(Spool, spool.id)).weight_used == 100

    async def test_skipped_while_a_print_is_tracked(self, ams):
        """The usage tracker deducts precisely at completion (#880)."""
        from backend.app.services import usage_tracker

        printer = await ams.make_printer()
        spool, _ = await _assign(ams, printer, weight_used=100)
        usage_tracker._active_sessions[printer.id] = usage_tracker.PrintSession(
            printer_id=printer.id, print_name="x", started_at=datetime.now()
        )

        await main.on_ams_change(printer.id, _ams(_tray(remain=40)))

        assert (await ams.get(Spool, spool.id)).weight_used == 100


async def test_reapplies_k_profile_when_printer_lost_it(ams):
    from backend.app.models.spool_k_profile import SpoolKProfile

    printer = await ams.make_printer()
    spool, _ = await _assign(ams, printer, tray_uuid=BL_UUID, slicer_filament="GFA00")
    await ams.add(
        SpoolKProfile(spool_id=spool.id, printer_id=printer.id, nozzle_diameter="0.4", k_value=0.02, cali_idx=5)
    )
    nozzle = SimpleNamespace(diameter="0.4", extruder=None, flow_matches=lambda _t: True)

    with patch("backend.app.main.resolve_slot_nozzle", return_value=nozzle):
        await main.on_ams_change(printer.id, _ams(_tray(tray_uuid=BL_UUID, cali_idx=-1)))

    kwargs = ams.client.extrusion_cali_sel.call_args.kwargs
    assert kwargs["cali_idx"] == 5
    assert kwargs["filament_id"] == "GFA00"


class TestRfidAutoAssign:
    async def test_unknown_bambu_spool_is_created_and_assigned(self, ams):
        printer = await ams.make_printer()

        await main.on_ams_change(
            printer.id,
            _ams(
                _tray(
                    1, tray_uuid=BL_UUID, tag_uid="AABBCCDD11223344", tray_info_idx="GFA00", tray_sub_brands="PLA Basic"
                )
            ),
        )

        [spool] = await ams.all(Spool)
        assert spool.tray_uuid == BL_UUID
        [assignment] = await ams.all(SpoolAssignment)
        assert (assignment.ams_id, assignment.tray_id, assignment.spool_id) == (0, 1, spool.id)
        auto = [c.args[0] for c in ams.ws.broadcast.await_args_list if c.args[0]["type"] == "spool_auto_assigned"]
        assert auto == [
            {"type": "spool_auto_assigned", "printer_id": printer.id, "ams_id": 0, "tray_id": 1, "spool_id": spool.id}
        ]

    async def test_known_tag_is_assigned_to_existing_spool(self, ams):
        printer = await ams.make_printer()
        spool = await ams.add(Spool(material="PLA", rgba="FF0000FF", tray_uuid=BL_UUID))

        await main.on_ams_change(printer.id, _ams(_tray(tray_uuid=BL_UUID, tray_info_idx="GFA00")))

        [assignment] = await ams.all(SpoolAssignment)
        assert assignment.spool_id == spool.id
        assert len(await ams.all(Spool)) == 1

    async def test_auto_add_disabled_prompts_instead(self, ams):
        printer = await ams.make_printer()
        await ams.set_setting("auto_add_unknown_rfid", "false")

        await main.on_ams_change(printer.id, _ams(_tray(tray_uuid=BL_UUID, tray_info_idx="GFA00")))

        assert await ams.all(Spool) == []
        unknown = [c.args[0] for c in ams.ws.broadcast.await_args_list if c.args[0]["type"] == "unknown_tag"]
        assert len(unknown) == 1
        assert unknown[0]["tray_uuid"] == BL_UUID

    async def test_third_party_tag_prompts_user(self, ams):
        printer = await ams.make_printer()

        await main.on_ams_change(printer.id, _ams(_tray(tag_uid="1122334455667788")))

        assert await ams.all(Spool) == []
        unknown = [c.args[0] for c in ams.ws.broadcast.await_args_list if c.args[0]["type"] == "unknown_tag"]
        assert unknown[0]["tag_uid"] == "1122334455667788"


class TestSpoolmanSync:
    @pytest.fixture
    async def spoolman(self, ams):
        await ams.set_setting("spoolman_enabled", "true")
        await ams.set_setting("spoolman_url", "http://spoolman.local:7912")
        client = MagicMock()
        client.health_check = AsyncMock(return_value=True)
        client.get_spools = AsyncMock(return_value=[])
        client.sync_ams_tray = AsyncMock(return_value={"id": 77})
        client.parse_ams_tray = lambda ams_id, tray: (
            SimpleNamespace(
                tray_id=int(tray["id"]),
                tray_uuid=tray.get("tray_uuid", ""),
                tag_uid=tray.get("tag_uid", ""),
                tray_type=tray["tray_type"],
                tray_color=tray["tray_color"],
                tray_sub_brands="",
                tray_info_idx="",
            )
            if tray.get("tray_type")
            else None
        )
        with (
            patch("backend.app.main.get_spoolman_client", AsyncMock(return_value=client)),
            patch("backend.app.services.slot_preset_writer.upsert_slot_preset_for_spoolman_spool", AsyncMock()),
        ):
            yield client

    async def _slots(self, env):
        from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment

        return {(s.ams_id, s.tray_id): s.spoolman_spool_id for s in await env.all(SpoolmanSlotAssignment)}

    async def test_syncs_trays_and_records_slot_assignments(self, ams, spoolman):
        printer = await ams.make_printer()

        await main.on_ams_change(printer.id, _ams(_tray(0, tray_uuid=BL_UUID), _tray(1, tray_type="")))

        assert spoolman.sync_ams_tray.await_args.args[1] == "Lifecycle Printer"
        assert spoolman.sync_ams_tray.await_args.kwargs["disable_weight_sync"] is True
        assert await self._slots(ams) == {(0, 0): 77}

    async def test_empty_tray_removes_slot_assignment(self, ams, spoolman):
        from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment

        printer = await ams.make_printer()
        await ams.add(SpoolmanSlotAssignment(printer_id=printer.id, ams_id=0, tray_id=1, spoolman_spool_id=12))
        spoolman.sync_ams_tray.return_value = None

        await main.on_ams_change(printer.id, _ams(_tray(1, tray_type="")))

        assert await self._slots(ams) == {}

    async def test_unreachable_spoolman_skips_sync(self, ams, spoolman):
        printer = await ams.make_printer()
        spoolman.health_check.return_value = False

        await main.on_ams_change(printer.id, _ams(_tray()))

        spoolman.sync_ams_tray.assert_not_awaited()

    async def test_manual_sync_mode_skips_sync(self, ams, spoolman):
        printer = await ams.make_printer()
        await ams.set_setting("spoolman_sync_mode", "manual")

        await main.on_ams_change(printer.id, _ams(_tray()))

        spoolman.sync_ams_tray.assert_not_awaited()

    async def test_unknown_tag_prompt_when_auto_add_disabled(self, ams, spoolman):
        printer = await ams.make_printer()
        await ams.set_setting("auto_add_unknown_rfid", "false")
        spoolman.sync_ams_tray.return_value = None

        await main.on_ams_change(printer.id, _ams(_tray(tray_uuid=BL_UUID)))

        unknown = [c.args[0] for c in ams.ws.broadcast.await_args_list if c.args[0]["type"] == "unknown_tag"]
        assert len(unknown) == 1
