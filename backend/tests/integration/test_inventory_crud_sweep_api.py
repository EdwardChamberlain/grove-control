"""Inventory CRUD endpoints: spool catalog, colour catalog, spool archive /
restore / delete, usage history, shopping list and slot assignment."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

INV = "/api/v1/inventory"


async def _spool(db, **kwargs):
    from backend.app.models.spool import Spool

    spool = Spool(material=kwargs.pop("material", "PLA"), **kwargs)
    db.add(spool)
    await db.commit()
    await db.refresh(spool)
    return spool


class TestSpoolCatalog:
    async def test_add_update_delete(self, async_client: AsyncClient):
        created = (await async_client.post(f"{INV}/catalog", json={"name": "Cardboard 1kg", "weight": 200})).json()
        updated = (
            await async_client.put(f"{INV}/catalog/{created['id']}", json={"name": "Cardboard", "weight": 210})
        ).json()
        deleted = await async_client.delete(f"{INV}/catalog/{created['id']}")

        assert (updated["name"], updated["weight"], updated["is_default"]) == ("Cardboard", 210, False)
        assert deleted.json() == {"status": "deleted"}

    async def test_missing_entries(self, async_client: AsyncClient):
        assert (await async_client.put(f"{INV}/catalog/9999", json={"name": "x", "weight": 1})).status_code == 404
        assert (await async_client.delete(f"{INV}/catalog/9999")).status_code == 404

    async def test_bulk_delete_and_reset(self, async_client: AsyncClient):
        ids = [
            (await async_client.post(f"{INV}/catalog", json={"name": f"S{i}", "weight": i})).json()["id"]
            for i in range(3)
        ]

        none = (await async_client.post(f"{INV}/catalog/bulk-delete", json={"ids": []})).json()
        some = (await async_client.post(f"{INV}/catalog/bulk-delete", json={"ids": ids[:2] + [9999]})).json()
        reset = await async_client.post(f"{INV}/catalog/reset")

        assert (none, some) == ({"deleted": 0}, {"deleted": 2})
        assert reset.status_code == 200
        entries = (await async_client.get(f"{INV}/catalog")).json()
        assert entries and all(e["is_default"] for e in entries)


class TestColorCatalog:
    async def test_reset_lookup_and_delete(self, async_client: AsyncClient):
        await async_client.post(f"{INV}/colors/reset")
        entries = (await async_client.get(f"{INV}/colors/search", params={"manufacturer": "Bambu"})).json()
        sample = entries[0]

        found = (
            await async_client.get(
                f"{INV}/colors/lookup",
                params={
                    "manufacturer": sample["manufacturer"],
                    "color_name": sample["color_name"],
                    "material": sample["material"],
                },
            )
        ).json()
        missing = (
            await async_client.get(f"{INV}/colors/lookup", params={"manufacturer": "Nobody", "color_name": "Void"})
        ).json()
        deleted = await async_client.delete(f"{INV}/colors/{sample['id']}")
        gone = await async_client.delete(f"{INV}/colors/{sample['id']}")

        assert (found["found"], found["hex_color"]) == (True, sample["hex_color"])
        assert missing == {"found": False, "hex_color": None, "material": None}
        assert (deleted.status_code, gone.status_code) == (200, 404)

    async def test_bulk_delete(self, async_client: AsyncClient):
        await async_client.post(f"{INV}/colors/reset")
        ids = [e["id"] for e in (await async_client.get(f"{INV}/colors/search")).json()[:3]]

        assert (await async_client.post(f"{INV}/colors/bulk-delete", json={"ids": []})).json() == {"deleted": 0}
        assert (await async_client.post(f"{INV}/colors/bulk-delete", json={"ids": ids})).json() == {"deleted": 3}


class TestSpoolLifecycle:
    async def test_archive_restore_delete(self, async_client: AsyncClient, db_session):
        spool = await _spool(db_session)

        archived = (await async_client.post(f"{INV}/spools/{spool.id}/archive")).json()
        restored = (await async_client.post(f"{INV}/spools/{spool.id}/restore")).json()
        deleted = await async_client.delete(f"{INV}/spools/{spool.id}")

        assert archived["archived_at"] is not None
        assert restored["archived_at"] is None
        assert deleted.json() == {"status": "deleted"}

    @pytest.mark.parametrize(
        ("method", "path"),
        [("post", "archive"), ("post", "restore"), ("delete", ""), ("get", "usage")],
    )
    async def test_missing_spool(self, async_client: AsyncClient, method, path):
        url = f"{INV}/spools/9999/{path}".rstrip("/")
        assert (await getattr(async_client, method)(url)).status_code == 404

    async def test_usage_history(self, async_client: AsyncClient, db_session, printer_factory):
        from backend.app.models.spool_usage_history import SpoolUsageHistory

        printer = await printer_factory()
        other = await printer_factory(name="Other")
        spool = await _spool(db_session)
        db_session.add_all(
            [
                SpoolUsageHistory(spool_id=spool.id, printer_id=printer.id, print_name="A", weight_used=10),
                SpoolUsageHistory(spool_id=spool.id, printer_id=other.id, print_name="B", weight_used=5),
            ]
        )
        await db_session.commit()

        per_spool = (await async_client.get(f"{INV}/spools/{spool.id}/usage")).json()
        by_printer = (await async_client.get(f"{INV}/usage", params={"printer_id": printer.id})).json()
        cleared = (await async_client.delete(f"{INV}/spools/{spool.id}/usage")).json()
        after = (await async_client.get(f"{INV}/usage")).json()

        assert len(per_spool) == 2
        assert [u["print_name"] for u in by_printer] == ["A"]
        assert (cleared, after) == ({"status": "cleared"}, [])


class TestShoppingList:
    async def test_remove_and_clear(self, async_client: AsyncClient):
        a = (await async_client.post(f"{INV}/shopping-list", json={"material": "PLA"})).json()
        await async_client.post(f"{INV}/shopping-list", json={"material": "PETG"})
        await async_client.post(f"{INV}/shopping-list", json={"material": "ABS"})

        removed = await async_client.delete(f"{INV}/shopping-list/{a['id']}")
        missing = await async_client.delete(f"{INV}/shopping-list/{a['id']}")
        cleared = (await async_client.delete(f"{INV}/shopping-list")).json()

        assert (removed.status_code, missing.status_code, cleared) == (200, 404, {"deleted": 2})


class TestSlots:
    def _printer_manager(self, raw_data):
        pm = MagicMock()
        pm.get_status.return_value = SimpleNamespace(raw_data=raw_data) if raw_data is not None else None
        pm.get_client.return_value = None
        pm.get_model.return_value = "X1C"
        return patch("backend.app.services.printer_manager.printer_manager", pm)

    async def test_assign_and_unassign(self, async_client: AsyncClient, db_session, printer_factory):
        printer = await printer_factory()
        spool = await _spool(db_session)

        with self._printer_manager({"ams": [{"id": "0", "tray": [{"id": "1", "tray_type": "PLA"}]}]}):
            assigned = await async_client.post(
                f"{INV}/assignments", json={"spool_id": spool.id, "printer_id": printer.id, "ams_id": 0, "tray_id": 1}
            )
        unassigned = await async_client.delete(f"{INV}/assignments/{printer.id}/0/1")
        again = await async_client.delete(f"{INV}/assignments/{printer.id}/0/1")

        assert assigned.status_code == 200, assigned.text
        assert (unassigned.status_code, again.status_code) == (200, 404)

    async def test_create_spool_from_tagged_slot(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        tray = {
            "id": "2",
            "tray_type": "PETG",
            "tray_color": "00FF00FF",
            "tray_uuid": "A1B2C3D4E5F60718293A4B5C6D7E8F90",
        }

        with self._printer_manager({"ams": {"ams": [{"id": "0", "tray": [tray]}]}}):
            response = await async_client.post(
                f"{INV}/spools/from-slot", json={"printer_id": printer.id, "ams_id": 0, "tray_id": 2}
            )

        assert response.status_code == 200, response.text
        assert response.json()["material"] == "PETG"

    @pytest.mark.parametrize(
        ("raw_data", "status", "detail"),
        [
            (None, 404, "Printer not connected"),
            ({"ams": [{"id": "0", "tray": [{"id": "0"}]}]}, 400, "Slot is empty"),
            ({"ams": {"tray": [{"id": "0", "tray_type": "PLA"}]}}, 400, "Slot has no RFID tag"),
        ],
    )
    async def test_create_spool_from_slot_errors(
        self, async_client: AsyncClient, printer_factory, raw_data, status, detail
    ):
        printer = await printer_factory()

        with self._printer_manager(raw_data):
            response = await async_client.post(
                f"{INV}/spools/from-slot", json={"printer_id": printer.id, "ams_id": 0, "tray_id": 0}
            )

        assert response.status_code == status
        assert detail in response.json()["detail"]
