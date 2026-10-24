"""Integration tests for ``POST /spoolman/sync-all``.

The Spoolman client and printer manager are mocked; the tests cover the
preconditions, the AMS data shapes the route accepts, how each tray outcome
is classified (synced / skipped / error) and the slot-assignment writes.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.settings import Settings
from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment
from backend.app.services.spoolman import AMSTray

ROUTES = "backend.app.api.routes.spoolman"
UUID = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4"


def tray(tray_id: int, *, uuid: str = "", tag: str = "", ams_id: int = 0) -> AMSTray:
    return AMSTray(
        ams_id=ams_id,
        tray_id=tray_id,
        tray_type="PLA",
        tray_sub_brands="PLA Basic",
        tray_color="FF0000FF",
        remain=80,
        tag_uid=tag,
        tray_uuid=uuid,
        tray_info_idx="GFA00",
        tray_weight=1000,
    )


@pytest.fixture
async def spoolman_enabled(db_session):
    db_session.add(Settings(key="spoolman_enabled", value="true"))
    db_session.add(Settings(key="spoolman_url", value="http://localhost:7912"))
    await db_session.commit()


@pytest.fixture
def client():
    mock = MagicMock()
    mock.health_check = AsyncMock(return_value=True)
    mock.get_spools = AsyncMock(return_value=[{"id": 5}])
    mock.sync_ams_tray = AsyncMock(return_value=None)
    mock.parse_ams_tray = MagicMock(return_value=None)
    with (
        patch(f"{ROUTES}.get_spoolman_client", AsyncMock(return_value=mock)),
        patch(f"{ROUTES}.init_spoolman_client", AsyncMock(return_value=mock)),
    ):
        yield mock


@pytest.fixture
def printer_states():
    """Map printer id → raw_data; printers without an entry are offline."""
    states: dict[int, dict] = {}

    def get_status(printer_id):
        if printer_id not in states:
            return None
        state = MagicMock()
        state.raw_data = states[printer_id]
        return state

    with patch(f"{ROUTES}.printer_manager") as pm:
        pm.get_status = MagicMock(side_effect=get_status)
        yield states


@pytest.mark.integration
class TestSyncAllPreconditions:
    async def test_requires_spoolman_enabled(self, async_client: AsyncClient):
        response = await async_client.post("/api/v1/spoolman/sync-all")
        assert response.status_code == 400
        assert "not enabled" in response.json()["detail"]

    async def test_unreachable_spoolman_is_503(self, async_client: AsyncClient, spoolman_enabled, client):
        client.health_check.return_value = False
        response = await async_client.post("/api/v1/spoolman/sync-all")
        assert response.status_code == 503

    async def test_spool_fetch_failure_is_503(self, async_client: AsyncClient, spoolman_enabled, client):
        client.get_spools.side_effect = RuntimeError("timeout")
        response = await async_client.post("/api/v1/spoolman/sync-all")
        assert response.status_code == 503
        assert "timeout" in response.json()["detail"]


@pytest.mark.integration
class TestSyncAllOutcomes:
    async def test_syncs_every_connected_printer_and_records_slots(
        self, async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory, db_session
    ):
        list_printer = await printer_factory(name="X1C")
        h2d = await printer_factory(name="H2D")
        offline = await printer_factory(name="Offline")
        await printer_factory(name="Disabled", is_active=False)
        ids = {"list": list_printer.id, "h2d": h2d.id, "offline": offline.id}

        printer_states[ids["list"]] = {"ams": [{"id": 0, "tray": [{"id": 0}, {"id": 1}]}]}
        printer_states[ids["h2d"]] = {"ams": {"ams": [{"id": 1, "tray": [{"id": 3}]}]}}

        trays = {(0, 0): tray(0, uuid=UUID), (0, 1): None, (1, 3): tray(3, uuid=UUID, ams_id=1)}
        client.parse_ams_tray.side_effect = lambda ams_id, data: trays[(ams_id, int(data["id"]))]
        client.sync_ams_tray.side_effect = [{"id": 5}, {"id": 77}]

        # A stale assignment on the now-empty tray must be removed.
        db_session.add(SpoolmanSlotAssignment(printer_id=ids["list"], ams_id=0, tray_id=1, spoolman_spool_id=9))
        await db_session.commit()

        response = await async_client.post("/api/v1/spoolman/sync-all")
        assert response.status_code == 200
        body = response.json()
        assert body == {"success": True, "synced_count": 2, "skipped_count": 0, "skipped": [], "errors": []}

        kwargs = client.sync_ams_tray.call_args_list[0].kwargs
        assert kwargs["disable_weight_sync"] is True
        assert kwargs["auto_add_unknown_rfid"] is True  # default when unset
        # The new spool id was appended to the shared cache for later trays.
        assert {"id": 77} in client.sync_ams_tray.call_args_list[1].kwargs["cached_spools"]

        db_session.expire_all()
        rows = (await db_session.execute(select(SpoolmanSlotAssignment))).scalars().all()
        assert {(r.printer_id, r.ams_id, r.tray_id, r.spoolman_spool_id) for r in rows} == {
            (ids["list"], 0, 0, 5),
            (ids["h2d"], 1, 3, 77),
        }

    async def test_single_unit_ams_dict_shape(
        self, async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory
    ):
        printer = await printer_factory()
        printer_states[printer.id] = {"ams": {"tray": [{"id": 2}]}}
        client.parse_ams_tray.return_value = tray(2, uuid=UUID)
        client.sync_ams_tray.return_value = {"id": 5}
        body = (await async_client.post("/api/v1/spoolman/sync-all")).json()
        assert body["synced_count"] == 1

    async def test_untagged_tray_without_assignment_is_skipped(
        self, async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory
    ):
        printer = await printer_factory(name="P1S")
        printer_states[printer.id] = {"ams": [{"id": 0, "tray": [{"id": 1}]}]}
        client.parse_ams_tray.return_value = tray(1)
        body = (await async_client.post("/api/v1/spoolman/sync-all")).json()
        assert body["success"] is True
        assert body["skipped"] == [
            {
                "location": "P1S AMS 0 T1",
                "reason": "No RFID tag and no slot assignment",
                "filament_type": "PLA",
                "color": "FF0000",
            }
        ]

    async def test_untagged_tray_uses_slot_assignment_hint(
        self, async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory, db_session
    ):
        printer = await printer_factory()
        printer_id = printer.id
        db_session.add(SpoolmanSlotAssignment(printer_id=printer_id, ams_id=0, tray_id=1, spoolman_spool_id=42))
        await db_session.commit()
        printer_states[printer_id] = {"ams": [{"id": 0, "tray": [{"id": 1}]}]}
        client.parse_ams_tray.return_value = tray(1)

        body = (await async_client.post("/api/v1/spoolman/sync-all")).json()
        assert body["skipped"] == []  # a hint exists, so the tray isn't reported as unknown
        assert client.sync_ams_tray.call_args.kwargs["spoolman_spool_id_hint"] == 42

    async def test_unknown_rfid_is_an_error_or_skip_depending_on_auto_add(
        self, async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory, db_session
    ):
        printer = await printer_factory(name="A1")
        printer_states[printer.id] = {"ams": [{"id": 0, "tray": [{"id": 0}]}]}
        client.parse_ams_tray.return_value = tray(0, tag="DEADBEEF")

        errored = (await async_client.post("/api/v1/spoolman/sync-all")).json()
        assert errored["success"] is False
        assert errored["errors"] == ["Spool not found in Spoolman: A1 AMS 0:0"]

        db_session.add(Settings(key="auto_add_unknown_rfid", value="false"))
        await db_session.commit()
        skipped = (await async_client.post("/api/v1/spoolman/sync-all")).json()
        assert skipped["success"] is True
        assert skipped["skipped"][0]["reason"] == "Auto-add disabled; add to inventory manually"

    async def test_per_tray_exception_is_reported_and_others_continue(
        self, async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory
    ):
        printer = await printer_factory(name="X1E")
        printer_states[printer.id] = {"ams": [{"id": 0, "tray": [{"id": 0}, {"id": 1}]}]}
        client.parse_ams_tray.side_effect = lambda ams_id, data: tray(int(data["id"]), uuid=UUID)
        client.sync_ams_tray.side_effect = [RuntimeError("boom"), {"id": 5}]

        body = (await async_client.post("/api/v1/spoolman/sync-all")).json()
        assert body["synced_count"] == 1
        assert body["errors"] == ["X1E AMS 0:0: boom"]


@pytest.mark.integration
async def test_single_printer_sync_skips_unknown_rfid_when_auto_add_disabled(
    async_client: AsyncClient, spoolman_enabled, client, printer_states, printer_factory, db_session
):
    """Regression: the skip reason must be a valid SkippedSpool reason, or the
    sync reports a validation error for every unknown spool instead."""
    printer = await printer_factory(name="A1 mini")
    printer_id = printer.id
    db_session.add(Settings(key="auto_add_unknown_rfid", value="false"))
    await db_session.commit()
    printer_states[printer_id] = {"ams": [{"id": 0, "tray": [{"id": 0}]}]}
    client.parse_ams_tray.return_value = tray(0, tag="DEADBEEF")

    response = await async_client.post(f"/api/v1/spoolman/sync/{printer_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["errors"] == []
    assert body["skipped"][0]["reason"] == "Auto-add disabled; add to inventory manually"
