"""K-profile (pressure advance) routes: reading, adding, editing (single and
dual nozzle), batch add, delete, and the local notes store."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

PROFILE = {
    "nozzle_id": "HS00-0.4",
    "nozzle_diameter": "0.4",
    "filament_id": "GFA00",
    "name": "Bambu PLA",
    "k_value": "0.020",
}


def _client(dual=False, ack=(True, None), set_result=7, delete_result=8):
    client = MagicMock()
    client.state = SimpleNamespace(connected=True)
    client._is_dual_nozzle = dual
    client.set_kprofile.return_value = set_result
    client.delete_kprofile.return_value = delete_result
    client.set_kprofiles_batch.return_value = set_result
    client.await_cali_ack = AsyncMock(return_value=ack)
    client.get_kprofiles = AsyncMock(
        return_value=[
            SimpleNamespace(
                slot_id=3,
                extruder_id=0,
                nozzle_id="HS00-0.4",
                nozzle_diameter="0.4",
                filament_id="GFA00",
                name="Bambu PLA",
                k_value="0.020",
                n_coef="1.4",
                ams_id=0,
                tray_id=1,
                setting_id="PFUS1",
            )
        ]
    )
    return client


@pytest.fixture
def connected():
    """Patch printer_manager to return the given client; returns a setter."""
    holder = {"client": _client()}
    with patch("backend.app.api.routes.kprofiles.printer_manager.get_client", side_effect=lambda pid: holder["client"]):
        yield holder


@pytest.fixture(autouse=True)
def no_sleep():
    with patch("backend.app.api.routes.kprofiles.asyncio.sleep", AsyncMock()):
        yield


def url(printer_id, suffix=""):
    return f"/api/v1/printers/{printer_id}/kprofiles/{suffix}"


class TestReadProfiles:
    async def test_lists_profiles(self, async_client: AsyncClient, printer_factory, connected):
        printer = await printer_factory()

        body = (await async_client.get(url(printer.id), params={"nozzle_diameter": "0.4"})).json()

        assert body["nozzle_diameter"] == "0.4"
        assert body["profiles"][0]["setting_id"] == "PFUS1"
        connected["client"].get_kprofiles.assert_awaited_once_with(nozzle_diameter="0.4")


class TestGuards:
    @pytest.mark.parametrize(
        ("method", "suffix", "body"),
        [
            ("get", "", None),
            ("post", "", PROFILE),
            ("post", "batch", [PROFILE]),
            ("delete", "", {**PROFILE, "slot_id": 1}),
        ],
    )
    async def test_unknown_printer_and_disconnected(
        self, async_client: AsyncClient, printer_factory, connected, method, suffix, body
    ):
        printer = await printer_factory()

        async def call(pid):
            return await async_client.request(method.upper(), url(pid, suffix), json=body)

        assert (await call(9999)).status_code == 404
        connected["client"] = None
        offline = await call(printer.id)
        assert (offline.status_code, offline.json()["detail"]) == (400, "Printer not connected")

    async def test_empty_batch(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()

        response = await async_client.post(url(printer.id, "batch"), json=[])

        assert (response.status_code, response.json()["detail"]) == (400, "No profiles provided")


class TestSetProfile:
    async def test_adds_a_new_profile(self, async_client: AsyncClient, printer_factory, connected):
        printer = await printer_factory()

        response = await async_client.post(url(printer.id), json=PROFILE)

        assert response.json() == {"success": True, "message": "K-profile added successfully"}
        kwargs = connected["client"].set_kprofile.call_args.kwargs
        assert (kwargs["slot_id"], kwargs["setting_id"]) == (0, None)
        connected["client"].delete_kprofile.assert_not_called()

    async def test_single_nozzle_edit_deletes_then_adds(self, async_client: AsyncClient, printer_factory, connected):
        printer = await printer_factory(model="X1C")

        response = await async_client.post(url(printer.id), json={**PROFILE, "slot_id": 3, "setting_id": "PFUS1"})

        assert response.json()["message"] == "K-profile updated successfully"
        assert connected["client"].delete_kprofile.call_args.kwargs["cali_idx"] == 3
        assert connected["client"].await_cali_ack.await_count == 2

    async def test_dual_nozzle_edit_is_in_place(self, async_client: AsyncClient, printer_factory, connected):
        connected["client"] = _client(dual=True)
        printer = await printer_factory()

        response = await async_client.post(url(printer.id), json={**PROFILE, "slot_id": 3})

        assert response.status_code == 200
        assert connected["client"].set_kprofile.call_args.kwargs["cali_idx"] == 3
        connected["client"].delete_kprofile.assert_not_called()

    @pytest.mark.parametrize(
        ("client_kwargs", "body", "detail"),
        [
            ({"set_result": None}, PROFILE, "Failed to send K-profile command"),
            ({"ack": (False, "slot full")}, PROFILE, "Printer rejected the K-profile: slot full"),
            ({"delete_result": None}, {**PROFILE, "slot_id": 3}, "Failed to delete existing K-profile for edit"),
            ({"ack": (False, "busy")}, {**PROFILE, "slot_id": 3}, "Printer rejected the K-profile edit: busy"),
        ],
    )
    async def test_failures(self, async_client: AsyncClient, printer_factory, connected, client_kwargs, body, detail):
        connected["client"] = _client(**client_kwargs)
        printer = await printer_factory(model="X1C")

        response = await async_client.post(url(printer.id), json=body)

        assert (response.status_code, response.json()["detail"]) == (500, detail)


class TestBatch:
    async def test_sends_one_command(self, async_client: AsyncClient, printer_factory, connected):
        printer = await printer_factory()

        response = await async_client.post(url(printer.id, "batch"), json=[PROFILE, {**PROFILE, "extruder_id": 1}])

        assert response.json() == {"success": True, "message": "Added 2 K-profiles"}
        dicts, diameter = connected["client"].set_kprofiles_batch.call_args.args
        assert ([d["extruder_id"] for d in dicts], diameter) == ([0, 1], "0.4")

    @pytest.mark.parametrize(
        ("client_kwargs", "detail"),
        [
            ({"set_result": None}, "Failed to send K-profiles batch command"),
            ({"ack": (False, "nope")}, "Printer rejected the K-profiles: nope"),
        ],
    )
    async def test_failures(self, async_client: AsyncClient, printer_factory, connected, client_kwargs, detail):
        connected["client"] = _client(**client_kwargs)
        printer = await printer_factory()

        response = await async_client.post(url(printer.id, "batch"), json=[PROFILE])

        assert (response.status_code, response.json()["detail"]) == (500, detail)


class TestDelete:
    async def test_deletes(self, async_client: AsyncClient, printer_factory, connected):
        printer = await printer_factory()

        response = await async_client.request("DELETE", url(printer.id), json={**PROFILE, "slot_id": 3})

        assert response.json() == {"success": True, "message": "K-profile deleted successfully"}

    @pytest.mark.parametrize(
        ("client_kwargs", "detail"),
        [
            ({"delete_result": None}, "Failed to send K-profile delete command"),
            ({"ack": (False, "in use")}, "Printer rejected the delete: in use"),
        ],
    )
    async def test_failures(self, async_client: AsyncClient, printer_factory, connected, client_kwargs, detail):
        connected["client"] = _client(**client_kwargs)
        printer = await printer_factory()

        response = await async_client.request("DELETE", url(printer.id), json={**PROFILE, "slot_id": 3})

        assert (response.status_code, response.json()["detail"]) == (500, detail)


class TestNotes:
    async def test_save_update_clear_and_delete(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        notes = url(printer.id, "notes")

        await async_client.put(notes, json={"setting_id": "A", "note": "first"})
        await async_client.put(notes, json={"setting_id": "A", "note": "second"})
        await async_client.put(notes, json={"setting_id": "B", "note": "keep"})
        assert (await async_client.get(notes)).json() == {"notes": {"A": "second", "B": "keep"}}

        cleared = await async_client.put(notes, json={"setting_id": "A", "note": "   "})
        already = await async_client.put(notes, json={"setting_id": "A", "note": ""})
        deleted = await async_client.delete(f"{notes}/B")
        missing = await async_client.delete(f"{notes}/B")

        assert [r.json()["message"] for r in (cleared, already, deleted, missing)] == ["Note deleted"] * 4
        assert (await async_client.get(notes)).json() == {"notes": {}}

    async def test_unknown_printer(self, async_client: AsyncClient):
        notes = url(9999, "notes")

        statuses = [
            (await async_client.get(notes)).status_code,
            (await async_client.put(notes, json={"setting_id": "A", "note": "x"})).status_code,
            (await async_client.delete(f"{notes}/A")).status_code,
        ]

        assert statuses == [404, 404, 404]
