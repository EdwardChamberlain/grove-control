"""SpoolmanClient HTTP layer against a fake Spoolman: retries, error
translation, location renames, find-or-create and extra fields."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from backend.app.services import spoolman as sm
from backend.app.services.spoolman import (
    SpoolmanClient,
    SpoolmanClientError,
    SpoolmanNotFoundError,
    SpoolmanUnavailableError,
)


class FakeSpoolman:
    """Routes keyed by (method, path) → response, a list of responses, or an exception."""

    def __init__(self):
        self.routes: dict[tuple[str, str], object] = {}
        self.calls: list[httpx.Request] = []

    def on(self, method: str, path: str, *responses):
        self.routes[(method, path)] = list(responses)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path.removeprefix("/api/v1")
        queue = self.routes.get((request.method, path))
        if not queue:
            return httpx.Response(404, json={"message": "no route"})
        result = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(result, Exception):
            raise result
        if isinstance(result, httpx.Response):
            return result
        status, body = result
        return httpx.Response(status, json=body)

    def bodies(self, method: str, path: str):
        import json

        return [json.loads(r.content) for r in self.calls if r.method == method and r.url.path == f"/api/v1{path}"]


@pytest.fixture
def fake():
    return FakeSpoolman()


@pytest.fixture
def client(fake):
    with (
        patch.object(sm, "lan_service_transport", side_effect=lambda: httpx.MockTransport(fake)),
        patch.object(sm.asyncio, "sleep", AsyncMock()),
    ):
        yield SpoolmanClient("http://spoolman.local/")


class TestHealthAndLists:
    async def test_health(self, client, fake):
        fake.on("GET", "/health", (200, {}))
        assert await client.health_check() is True
        assert client.is_connected is True

        fake.on("GET", "/health", httpx.ConnectError("down"))
        assert await client.health_check() is False
        assert client.is_connected is False

    async def test_get_spools_retries_connection_errors(self, client, fake):
        fake.on("GET", "/spool", httpx.ReadError("reset"), httpx.RemoteProtocolError("bad"), (200, [{"id": 1}]))

        assert await client.get_spools() == [{"id": 1}]

    @pytest.mark.parametrize("failure", [httpx.ConnectError("down"), (500, {"error": "boom"})])
    async def test_get_spools_gives_up_after_three_attempts(self, client, fake, failure):
        fake.on("GET", "/spool", failure)

        with pytest.raises(SpoolmanUnavailableError):
            await client.get_spools()
        assert len(fake.calls) == 3

    async def test_get_all_spools_and_locations(self, client, fake):
        fake.on("GET", "/spool", httpx.ConnectError("x"), (500, {}), (200, [{"id": 2}]))
        fake.on("GET", "/location", (200, ["Shelf", {"name": "Dry box"}, {"nope": 1}, 3]))

        assert await client.get_all_spools(allow_archived=True) == [{"id": 2}]
        assert fake.calls[-1].url.params["allow_archived"] == "true"
        assert await client.get_distinct_locations() == ["Shelf", "Dry box"]

        fake.on("GET", "/location", (200, {"weird": True}))
        assert await client.get_distinct_locations() == []

    @pytest.mark.parametrize("failure", [httpx.ConnectError("down"), (503, {})])
    async def test_get_with_retry_gives_up(self, client, fake, failure):
        fake.on("GET", "/location", failure)

        with pytest.raises(SpoolmanUnavailableError):
            await client.get_distinct_locations()

    @pytest.mark.parametrize(
        ("method_name", "path"),
        [("get_filaments", "/filament"), ("get_external_filaments", "/external/filament"), ("get_vendors", "/vendor")],
    )
    async def test_simple_lists(self, client, fake, method_name, path):
        fake.on("GET", path, (200, [{"id": 1}]))
        assert await getattr(client, method_name)() == [{"id": 1}]

        fake.on("GET", path, (500, {}))
        with pytest.raises(SpoolmanUnavailableError):
            await getattr(client, method_name)()

    async def test_close_is_idempotent(self, client, fake):
        fake.on("GET", "/health", (200, {}))
        await client.health_check()
        await client.close()
        await client.close()
        assert client._client is None


class TestCreate:
    async def test_vendor(self, client, fake):
        fake.on("POST", "/vendor", (200, {"id": 5}))
        assert await client.create_vendor("Bambu") == {"id": 5}

        fake.on("POST", "/vendor", (422, {}))
        with pytest.raises(SpoolmanClientError) as err:
            await client.create_vendor("Bambu")
        assert err.value.status_code == 422

        fake.on("POST", "/vendor", (500, {}))
        with pytest.raises(SpoolmanUnavailableError):
            await client.create_vendor("Bambu")

    async def test_filament_payload(self, client, fake):
        fake.on("POST", "/filament", (200, {"id": 9}))

        await client.create_filament(
            " PETG HF ", vendor_id=3, material="PETG", color_hex="FF0000FF", color_name="Red", weight=1000
        )
        await client.create_filament("Mystery")

        first, second = fake.bodies("POST", "/filament")
        assert first == {
            "name": "PETG HF",
            "diameter": 1.75,
            "density": 1.27,
            "vendor_id": 3,
            "material": "PETG",
            "color_hex": "FF0000",
            "color_name": "Red",
            "weight": 1000,
        }
        assert second == {"name": "Mystery", "diameter": 1.75, "density": 1.24}

    async def test_filament_errors(self, client, fake):
        with pytest.raises(ValueError):
            await client.create_filament("  ")
        fake.on("POST", "/filament", (400, {}))
        with pytest.raises(SpoolmanClientError):
            await client.create_filament("PLA")
        fake.on("POST", "/filament", httpx.ConnectError("x"))
        with pytest.raises(SpoolmanUnavailableError):
            await client.create_filament("PLA")

    @pytest.mark.parametrize(("material", "density"), [("petg", 1.27), ("ABS-GF", 1.04), ("PP", 0.90), (None, 1.24)])
    def test_densities(self, material, density):
        assert SpoolmanClient("http://x")._get_material_density(material) == density

    @pytest.mark.xfail(
        strict=True,
        reason="Bug: _get_material_density checks prefixes in dict order, so 'PLA-CF' matches 'PLA' (1.24) "
        "and 'PA-CF' matches 'PA' (1.14) before their own entries are reached",
    )
    @pytest.mark.parametrize(("material", "density"), [("PLA-CF", 1.29), ("PA-CF", 1.20)])
    def test_carbon_fibre_densities(self, material, density):
        assert SpoolmanClient("http://x")._get_material_density(material) == density

    async def test_spool(self, client, fake):
        fake.on("POST", "/spool", (200, {"id": 11}))
        await client.create_spool(
            4, remaining_weight=800, location="AMS A1", lot_nr="L1", comment="c", extra={"tag": '"X"'}
        )
        assert fake.bodies("POST", "/spool")[0] == {
            "filament_id": 4,
            "remaining_weight": 800,
            "location": "AMS A1",
            "lot_nr": "L1",
            "comment": "c",
            "extra": {"tag": '"X"'},
        }

        for status, error in [
            (404, SpoolmanNotFoundError),
            (409, SpoolmanClientError),
            (500, SpoolmanUnavailableError),
        ]:
            fake.on("POST", "/spool", (status, {}))
            with pytest.raises(error):
                await client.create_spool(4)


class TestSpoolRequests:
    async def test_updates(self, client, fake):
        fake.on("PATCH", "/spool/3", (200, {"id": 3}))

        await client.update_spool(3, remaining_weight=10, location="Shelf", extra={"a": "1"})
        await client.update_spool(3, clear_location=True)
        await client.update_spool_full(
            3,
            filament_id=2,
            remaining_weight=5,
            comment="",
            price=20,
            clear_location=True,
            extra={},
            clear_spool_weight=True,
        )
        await client.update_spool_full(3, location="Box", spool_weight=250, comment="hi")
        await client.set_spool_archived(3, True)
        await client.reset_spool_usage(3)

        bodies = fake.bodies("PATCH", "/spool/3")
        assert bodies[0]["location"] == "Shelf" and "last_used" in bodies[0]
        assert bodies[1]["location"] is None
        assert bodies[2] == {
            "filament_id": 2,
            "remaining_weight": 5,
            "comment": None,
            "price": 20,
            "location": None,
            "extra": {},
            "spool_weight": None,
        }
        assert bodies[3] == {"location": "Box", "spool_weight": 250, "comment": "hi"}
        assert bodies[4:] == [{"archived": True}, {"used_weight": 0}]

    @pytest.mark.parametrize(
        ("response", "error"),
        [
            ((404, {}), SpoolmanNotFoundError),
            ((400, {"message": "bad"}), SpoolmanClientError),
            ((502, {}), SpoolmanUnavailableError),
            (httpx.ConnectError("x"), SpoolmanUnavailableError),
        ],
    )
    async def test_errors(self, client, fake, response, error):
        fake.on("GET", "/spool/3", response)
        fake.on("DELETE", "/spool/3", response)

        with pytest.raises(error):
            await client.get_spool(3)
        with pytest.raises(error):
            await client.delete_spool(3)

    async def test_merge_extra_keeps_existing_fields(self, client, fake):
        fake.on("GET", "/spool/3", (200, {"id": 3, "extra": {"tag": '"T"'}}))
        fake.on("PATCH", "/spool/3", (200, {"id": 3}))

        await client.merge_spool_extra(3, {"note": '"n"'})

        assert fake.bodies("PATCH", "/spool/3")[0]["extra"] == {"tag": '"T"', "note": '"n"'}
        assert client.extra_lock(3) is client.extra_lock(3)

    async def test_use_spool(self, client, fake):
        fake.on("PUT", "/spool/3/use", (200, {"id": 3}))
        assert await client.use_spool(3, 12.5) == {"id": 3}
        assert fake.bodies("PUT", "/spool/3/use") == [{"use_weight": 12.5}]

        for status, error in [
            (404, SpoolmanNotFoundError),
            (422, SpoolmanClientError),
            (500, SpoolmanUnavailableError),
        ]:
            fake.on("PUT", "/spool/3/use", (status, {}))
            with pytest.raises(error):
                await client.use_spool(3, 1)


class TestFilamentRequests:
    async def test_get_and_patch(self, client, fake):
        fake.on("GET", "/filament/2", (200, {"id": 2}))
        fake.on("PATCH", "/filament/2", (200, {"id": 2, "name": "New"}))

        assert await client.get_filament(2) == {"id": 2}
        assert (await client.patch_filament(2, {"name": "New"}))["name"] == "New"

    async def test_invalid_ids(self, client):
        with pytest.raises(ValueError):
            await client.get_filament(0)
        with pytest.raises(ValueError):
            await client.patch_filament(-1, {})

    @pytest.mark.parametrize(
        ("response", "error"),
        [
            ((404, {}), SpoolmanNotFoundError),
            ((400, {}), SpoolmanClientError),
            ((500, {}), SpoolmanUnavailableError),
            (httpx.ReadTimeout("slow"), SpoolmanUnavailableError),
        ],
    )
    async def test_errors(self, client, fake, response, error):
        fake.on("GET", "/filament/2", response)
        with pytest.raises(error):
            await client.get_filament(2)


class TestRenameLocation:
    async def test_bulk_endpoint(self, client, fake):
        fake.on("PATCH", "/location/Old Shelf", (200, {}))

        assert await client.rename_location("Old Shelf", "New") == 0

    async def test_falls_back_to_each_spool(self, client, fake):
        fake.on("PATCH", "/location/Old", (405, {}))
        fake.on(
            "GET",
            "/spool",
            (200, [{"id": 1, "location": "Old"}, {"id": 2, "location": "Other"}, {"id": 3, "location": " Old "}]),
        )
        fake.on("PATCH", "/spool/1", (200, {}))
        fake.on("PATCH", "/spool/3", (404, {}))  # deleted meanwhile: skipped

        assert await client.rename_location("Old", "New") == 1

    async def test_fallback_failures_are_collected(self, client, fake):
        fake.on("PATCH", "/location/Old", (404, {}))
        fake.on("GET", "/spool", (200, [{"id": 1, "location": "Old"}]))
        fake.on("PATCH", "/spool/1", (500, {}))

        with pytest.raises(SpoolmanClientError, match="failed for 1 spool"):
            await client.rename_location("Old", "New")

    async def test_other_errors_propagate(self, client, fake):
        fake.on("PATCH", "/location/Old", (500, {}))

        with pytest.raises(httpx.HTTPStatusError):
            await client.rename_location("Old", "New")


class TestFindOrCreate:
    async def test_vendor(self, client, fake):
        fake.on("GET", "/vendor", (200, [{"id": 1, "name": "Bambu Lab"}, {"id": 2, "name": " Elegoo "}]))
        fake.on("POST", "/vendor", (200, {"id": 7}))

        assert await client.find_or_create_vendor("bambu lab") == 1
        assert await client.find_or_create_vendor("elegoo ") == 2
        assert await client.find_or_create_vendor("Polymaker") == 7
        assert await client.ensure_bambu_vendor() == 1

        fake.on("POST", "/vendor", (200, {"name": "x"}))
        with pytest.raises(SpoolmanUnavailableError):
            await client.find_or_create_vendor("Nobody")

    async def test_ensure_bambu_vendor_creates_it(self, client, fake):
        fake.on("GET", "/vendor", (200, []))
        fake.on("POST", "/vendor", (200, {"id": 4}))

        assert await client.ensure_bambu_vendor() == 4

    async def test_filament_matches_ams_style_names(self, client, fake):
        fake.on("GET", "/vendor", (200, [{"id": 1, "name": "Bambu Lab"}]))
        fake.on(
            "GET",
            "/filament",
            (
                200,
                [{"id": 20, "name": "Glow", "material": "PLA", "color_hex": "00ff00", "vendor": {"name": "Bambu Lab"}}],
            ),
        )

        assert await client.find_or_create_filament("PLA", "Glow", "Bambu Lab", "00FF00FF", 1000) == 20

    async def test_filament_is_created_when_missing(self, client, fake):
        fake.on("GET", "/filament", (200, [{"id": 20, "name": "PLA", "material": "PLA", "color_hex": "000000"}]))
        fake.on("POST", "/filament", (200, {"id": 21}))

        assert await client.find_or_create_filament("PLA", "", None, "fff", 1000) == 21
        assert fake.bodies("POST", "/filament")[0]["color_hex"] == "FFF"

        fake.on("POST", "/filament", (200, {}))
        with pytest.raises(SpoolmanUnavailableError):
            await client.find_or_create_filament("PLA", "", None, "abc", 1000)


class TestLookupsAndCleanup:
    SPOOLS = [
        {"id": 1, "location": "X1 - AMS A1", "extra": {"tag": '"' + "A" * 32 + '"'}},
        {"id": 2, "location": "X1 - AMS A2", "extra": {"tag": '"' + "B" * 32 + '"'}},
        {"id": 3, "location": "X1 - AMS A3", "extra": {"tag": '"short"'}},
        {"id": 4, "location": "X1 - AMS A4", "extra": None},
        {"id": 5, "location": "Shelf", "extra": {}},
    ]

    async def test_find_by_tag_and_location(self, client, fake):
        fake.on("GET", "/spool", (200, self.SPOOLS))

        assert (await client.find_spool_by_tag("b" * 32))["id"] == 2
        assert await client.find_spool_by_tag("nope", cached_spools=self.SPOOLS) is None
        assert client._find_spool_by_location("Shelf", self.SPOOLS)["id"] == 5
        assert client._find_spool_by_location("Shelf", None) is None
        assert client._find_spool_by_location("Nowhere", self.SPOOLS) is None
        assert [s["id"] for s in await client.find_spools_by_location_prefix("X1 - ")] == [1, 2, 3, 4]

    async def test_clears_only_removed_bambu_spools(self, client, fake):
        fake.on("PATCH", "/spool/2", (200, {"id": 2}))

        cleared = await client.clear_location_for_removed_spools(
            "X1", {"A" * 32}, cached_spools=self.SPOOLS, synced_spool_ids={1}
        )

        assert cleared == 1
        assert fake.bodies("PATCH", "/spool/2")[0]["location"] is None

    async def test_extra_fields(self, client, fake):
        fake.on("GET", "/field/spool/tag", (200, {}))
        assert await client.ensure_tag_extra_field() is True

        fake.on("GET", "/field/spool/note", (404, {}))
        fake.on("POST", "/field/spool/note", (201, {}))
        assert await client.ensure_extra_field("note") is True

        fake.on("POST", "/field/spool/note", (400, {}))
        assert await client.ensure_extra_field("note") is False

        fake.on("GET", "/field/spool/note", httpx.ConnectError("x"))
        assert await client.ensure_extra_field("note") is False


class TestTrayHelpers:
    def test_parse_tray(self):
        c = SpoolmanClient("http://x")

        tray = c.parse_ams_tray(
            1,
            {
                "id": "2",
                "tray_type": "PLA ",
                "tray_color": "FF0000FF",
                "tag_uid": "0000000000000000",
                "tray_uuid": "00000000000000000000000000000000",
                "remain": "40",
                "tray_weight": "500",
            },
        )

        assert (tray.tray_id, tray.tray_type, tray.tray_sub_brands, tray.tag_uid, tray.tray_uuid) == (
            2,
            "PLA",
            "PLA",
            "",
            "",
        )
        assert (tray.remain, tray.tray_weight) == (40, 500)
        assert c.parse_ams_tray(0, {"tray_type": ""}) is None
        assert c.parse_ams_tray(0, {"tray_type": "PLA", "tray_color": " "}) is None

    @pytest.mark.parametrize(
        ("ams_id", "tray_id", "location"),
        [(0, 0, "AMS A1"), (2, 3, "AMS C4"), (129, 0, "AMS-HT B1"), (255, 0, "External Spool")],
    )
    def test_locations(self, ams_id, tray_id, location):
        assert SpoolmanClient("http://x").convert_ams_slot_to_location(ams_id, tray_id) == location
