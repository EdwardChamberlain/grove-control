"""Inventory routes: assignments list, RFID tag linking, AMS weight sync,
K-profile replacement, SKU reorder settings, shopping list and the
FilamentColors catalogue sync."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

UUID = "A1B2C3D4E5F60718293A4B5C6D7E8F90"


async def _spool(db, **kwargs):
    from backend.app.models.spool import Spool

    defaults = {"material": "PLA", "rgba": "FF0000FF", "label_weight": 1000, "weight_used": 0}
    defaults.update(kwargs)
    spool = Spool(**defaults)
    db.add(spool)
    await db.commit()
    await db.refresh(spool)
    return spool


async def _assign(db, spool, printer, ams_id=0, tray_id=0):
    from backend.app.models.spool_assignment import SpoolAssignment

    row = SpoolAssignment(spool_id=spool.id, printer_id=printer.id, ams_id=ams_id, tray_id=tray_id)
    db.add(row)
    await db.commit()
    return row


def _printers(statuses: dict):
    pm = MagicMock()
    pm.get_all_statuses.return_value = statuses
    pm.get_status.side_effect = lambda pid: statuses.get(pid)
    return patch("backend.app.services.printer_manager.printer_manager", pm)


class TestAssignmentsList:
    async def test_attaches_ams_labels_by_serial_and_fallback_key(
        self, async_client: AsyncClient, db_session, printer_factory
    ):
        from backend.app.models.ams_label import AmsLabel

        printer = await printer_factory()
        other = await printer_factory(name="Other")
        await _assign(db_session, await _spool(db_session), printer, ams_id=0)
        await _assign(db_session, await _spool(db_session), printer, ams_id=1)
        await _assign(db_session, await _spool(db_session), other, ams_id=0)
        db_session.add_all(
            [
                AmsLabel(ams_serial_number="SN-A", label="Left AMS"),
                AmsLabel(ams_serial_number=f"p{other.id}a0", label="Offline AMS"),
            ]
        )
        await db_session.commit()
        status = SimpleNamespace(raw_data={"ams": [{"id": "0", "sn": "SN-A"}, {"id": "bad", "sn": "X"}, {"id": "1"}]})

        with _printers({printer.id: status}):
            body = (await async_client.get("/api/v1/inventory/assignments")).json()
            filtered = (await async_client.get("/api/v1/inventory/assignments", params={"printer_id": other.id})).json()

        labels = {(a["printer_id"], a["ams_id"]): a["ams_label"] for a in body}
        assert labels == {(printer.id, 0): "Left AMS", (printer.id, 1): None, (other.id, 0): "Offline AMS"}
        assert [a["printer_id"] for a in filtered] == [other.id]


class TestLinkTag:
    async def _link(self, client, spool_id, **payload):
        return await client.patch(f"/api/v1/inventory/spools/{spool_id}/link-tag", json=payload)

    async def test_links_normalised_tag_and_uuid(self, async_client: AsyncClient, db_session):
        spool = await _spool(db_session)

        response = await self._link(
            async_client, spool.id, tag_uid="aa:bb:cc:dd", tray_uuid=UUID.lower(), tag_type="ntag"
        )

        body = response.json()
        assert (body["tag_uid"], body["tray_uuid"], body["tag_type"], body["data_origin"]) == (
            "AABBCCDD",
            UUID,
            "ntag",
            "nfc_link",
        )

    async def test_conflicts_with_another_active_spool(self, async_client: AsyncClient, db_session):
        await _spool(db_session, tag_uid="AABBCCDD", tray_uuid=UUID)
        spool = await _spool(db_session)

        assert (await self._link(async_client, spool.id, tag_uid="AABBCCDD")).status_code == 409
        assert (await self._link(async_client, spool.id, tray_uuid=UUID)).status_code == 409

    async def test_recycles_tags_from_archived_spools(self, async_client: AsyncClient, db_session):
        from datetime import datetime, timezone

        from backend.app.models.spool import Spool

        old = await _spool(db_session, tag_uid="AABBCCDD", tray_uuid=UUID, archived_at=datetime.now(timezone.utc))
        spool = await _spool(db_session)

        response = await self._link(async_client, spool.id, tag_uid="AABBCCDD", tray_uuid=UUID)

        assert response.status_code == 200
        await db_session.refresh(old)
        recycled = old
        assert (recycled.tag_uid, recycled.tray_uuid) == (None, None)

    @pytest.mark.parametrize(
        ("payload", "detail"),
        [
            ({"tag_uid": "zz"}, "tag_uid must contain hexadecimal characters"),
            ({"tag_uid": "ABC"}, "tag_uid must have an even number of hex characters"),
            ({"tray_uuid": "AABB"}, "tray_uuid must be exactly 32 hex characters"),
        ],
    )
    async def test_rejects_malformed_tags(self, async_client: AsyncClient, db_session, payload, detail):
        spool = await _spool(db_session)

        response = await self._link(async_client, spool.id, **payload)

        assert (response.status_code, response.json()["detail"]) == (422, detail)

    async def test_missing_and_archived_spools(self, async_client: AsyncClient, db_session):
        from datetime import datetime, timezone

        archived = await _spool(db_session, archived_at=datetime.now(timezone.utc))

        assert (await self._link(async_client, 9999, tag_uid="AA")).status_code == 404
        assert (await self._link(async_client, archived.id, tag_uid="AA")).status_code == 400


class TestSyncWeightsFromAms:
    async def test_overwrites_weight_from_remain(self, async_client: AsyncClient, db_session, printer_factory):
        from backend.app.models.spool import Spool

        printer = await printer_factory()
        offline = await printer_factory(name="Offline")
        synced = await _spool(db_session, weight_used=900)  # higher than AMS: still overwritten
        same = await _spool(db_session, weight_used=500)
        locked = await _spool(db_session, weight_used=1, weight_locked=True)
        no_tray = await _spool(db_session)
        no_remain = await _spool(db_session)
        bad_remain = await _spool(db_session)
        out_of_range = await _spool(db_session)
        not_connected = await _spool(db_session)
        for spool, tray in ((synced, 0), (same, 1), (locked, 2), (no_tray, 3)):
            await _assign(db_session, spool, printer, tray_id=tray)
        for spool, ams in ((no_remain, 1), (bad_remain, 2), (out_of_range, 3)):
            await _assign(db_session, spool, printer, ams_id=ams)
        await _assign(db_session, not_connected, offline)
        status = SimpleNamespace(
            raw_data={
                "ams": {
                    "ams": [
                        {
                            "id": "0",
                            "tray": [{"id": "0", "remain": 40}, {"id": "1", "remain": "50"}, {"id": "2", "remain": 10}],
                        },
                        {"id": "1", "tray": [{"id": "0"}]},
                        {"id": "2", "tray": [{"id": "0", "remain": "lots"}]},
                        {"id": "3", "tray": [{"id": "0", "remain": 140}]},
                    ]
                }
            }
        )

        with _printers({printer.id: status}):
            response = await async_client.post("/api/v1/inventory/sync-ams-weights")

        assert response.json() == {"synced": 1, "skipped": 7}
        await db_session.refresh(synced)
        await db_session.refresh(locked)
        assert synced.weight_used == 600.0
        assert locked.weight_used == 1


class TestKProfiles:
    async def test_replaces_all_profiles(self, async_client: AsyncClient, db_session, printer_factory):
        printer = await printer_factory()
        spool = await _spool(db_session)
        url = f"/api/v1/inventory/spools/{spool.id}/k-profiles"
        await async_client.put(url, json=[{"printer_id": printer.id, "k_value": 0.02}])

        response = await async_client.put(
            url,
            json=[
                {"printer_id": printer.id, "k_value": 0.025, "cali_idx": 3, "name": "PLA 0.4"},
                {"printer_id": printer.id, "k_value": 0.03, "nozzle_diameter": "0.6"},
            ],
        )

        assert sorted(p["k_value"] for p in response.json()) == [0.025, 0.03]
        assert (await async_client.put("/api/v1/inventory/spools/9999/k-profiles", json=[])).status_code == 404


class TestSkuSettings:
    async def test_creates_then_updates(self, async_client: AsyncClient):
        payload = {"material": "PLA", "brand": "Bambu", "color_name": "Red", "lead_time_days": 5}

        created = (await async_client.post("/api/v1/inventory/sku-settings", json=payload)).json()
        updated = (
            await async_client.post(
                "/api/v1/inventory/sku-settings", json={**payload, "lead_time_days": 9, "alerts_snoozed": True}
            )
        ).json()

        assert created["id"] == updated["id"]
        assert (updated["lead_time_days"], updated["alerts_snoozed"]) == (9, True)


class TestShoppingList:
    async def test_status_transitions(self, async_client: AsyncClient):
        item = (await async_client.post("/api/v1/inventory/shopping-list", json={"material": "PETG"})).json()
        url = f"/api/v1/inventory/shopping-list/{item['id']}/status"

        purchased = (await async_client.patch(url, json={"status": "purchased"})).json()
        received = (await async_client.patch(url, json={"status": "received"})).json()
        pending = (await async_client.patch(url, json={"status": "pending"})).json()

        assert purchased["purchased_at"] is not None
        # Receiving keeps the original purchase time.
        assert received["purchased_at"] == purchased["purchased_at"]
        assert (pending["status"], pending["purchased_at"]) == ("pending", None)

    async def test_status_errors(self, async_client: AsyncClient):
        item = (await async_client.post("/api/v1/inventory/shopping-list", json={"material": "PETG"})).json()

        bad = await async_client.patch(f"/api/v1/inventory/shopping-list/{item['id']}/status", json={"status": "lost"})
        missing = await async_client.patch("/api/v1/inventory/shopping-list/9999/status", json={"status": "pending"})

        assert (bad.status_code, missing.status_code) == (400, 404)


class FakeColorsClient:
    """Stands in for httpx.AsyncClient against the FilamentColors API."""

    pages: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        page = FakeColorsClient.pages[params["page"] - 1]
        if isinstance(page, Exception):
            raise page
        return httpx.Response(200, json=page, request=httpx.Request("GET", url))


def _events(response) -> list[dict]:
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


class TestColorSync:
    async def test_streams_progress_and_adds_new_colours(self, async_client: AsyncClient):
        swatch = {
            "manufacturer": {"name": "Bambu"},
            "filament_type": {"name": "PLA"},
            "color_name": "Jade",
            "hex_color": "00a86b",
        }
        FakeColorsClient.pages = [
            {
                "count": 4,
                "next": "page2",
                "results": [swatch, swatch, {"manufacturer": None, "color_name": "", "hex_color": ""}],
            },
            {"count": 4, "next": None, "results": [{**swatch, "color_name": "Ruby", "hex_color": "#E0115F"}]},
        ]

        with patch("backend.app.api.routes.inventory.httpx.AsyncClient", FakeColorsClient):
            response = await async_client.post("/api/v1/inventory/colors/sync")

        events = _events(response)
        assert [e["type"] for e in events] == ["progress", "progress", "complete"]
        assert events[-1] == {"type": "complete", "added": 2, "skipped": 2, "total_fetched": 4, "total_available": 4}
        colours = (await async_client.get("/api/v1/inventory/colors/search", params={"manufacturer": "bambu"})).json()
        assert {(c["color_name"], c["hex_color"]) for c in colours} >= {("Jade", "#00A86B"), ("Ruby", "#E0115F")}

    async def test_reports_http_errors(self, async_client: AsyncClient):
        FakeColorsClient.pages = [httpx.ConnectError("unreachable")]

        with patch("backend.app.api.routes.inventory.httpx.AsyncClient", FakeColorsClient):
            response = await async_client.post("/api/v1/inventory/colors/sync")

        assert _events(response) == [{"type": "error", "error": "unreachable"}]

    async def test_reports_unexpected_errors(self, async_client: AsyncClient):
        FakeColorsClient.pages = [ValueError("bad json")]

        with patch("backend.app.api.routes.inventory.httpx.AsyncClient", FakeColorsClient):
            response = await async_client.post("/api/v1/inventory/colors/sync")

        assert _events(response) == [{"type": "error", "error": "Unexpected error during sync"}]
