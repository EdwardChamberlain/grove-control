"""Camera stream bookkeeping endpoints: status/stall detection, stopping
streams, and plate-detection reference management."""

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.api.routes import camera

pytestmark = pytest.mark.integration

_STATE = (
    "_active_streams",
    "_active_chamber_streams",
    "_active_external_streams",
    "_last_frame_times",
    "_stream_start_times",
    "_last_frames",
    "_disconnect_events",
    "_spawned_ffmpeg_pids",
    "_stream_last_frame_times",
)


@pytest.fixture(autouse=True)
def clean_state():
    saved = {name: dict(getattr(camera, name)) for name in _STATE}
    for name in _STATE:
        getattr(camera, name).clear()
    yield
    for name in _STATE:
        getattr(camera, name).clear()
        getattr(camera, name).update(saved[name])


class TestStatus:
    async def test_no_stream(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()

        body = (await async_client.get(f"/api/v1/printers/{printer.id}/camera/status")).json()

        assert body == {
            "active": False,
            "has_frames": False,
            "seconds_since_frame": None,
            "stream_uptime": None,
            "stalled": False,
        }

    async def test_running_ffmpeg_stream_without_recent_frames_is_stalled(
        self, async_client: AsyncClient, printer_factory
    ):
        printer = await printer_factory()
        camera._active_streams[f"{printer.id}-abc"] = SimpleNamespace(returncode=None)
        camera._stream_start_times[printer.id] = time.time() - 30
        camera._last_frame_times[printer.id] = time.time() - 20
        camera._last_frames[printer.id] = b"jpg"

        body = (await async_client.get(f"/api/v1/printers/{printer.id}/camera/status")).json()

        assert (body["active"], body["has_frames"], body["stalled"]) == (True, True, True)
        assert body["seconds_since_frame"] >= 20

    async def test_fresh_frames_are_not_stalled(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        camera._active_external_streams[printer.id] = 1
        camera._stream_start_times[printer.id] = time.time() - 30
        camera._last_frame_times[printer.id] = time.time()

        body = (await async_client.get(f"/api/v1/printers/{printer.id}/camera/status")).json()

        assert (body["active"], body["stalled"]) == (True, False)

    async def test_chamber_stream_counts_and_exited_ffmpeg_does_not(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        other = await printer_factory(name="Other")
        camera._active_streams[f"{other.id}-dead"] = SimpleNamespace(returncode=1)
        camera._active_chamber_streams[f"{printer.id}-x"] = (None, None)

        chamber = (await async_client.get(f"/api/v1/printers/{printer.id}/camera/status")).json()
        dead = (await async_client.get(f"/api/v1/printers/{other.id}/camera/status")).json()

        assert (chamber["active"], dead["active"]) == (True, False)


class TestStop:
    async def test_skips_while_other_viewers_are_attached(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()

        with patch("backend.app.api.routes.camera.get_subscriber_count", return_value=2):
            body = (await async_client.post(f"/api/v1/printers/{printer.id}/camera/stop")).json()

        assert body == {"stopped": 0, "skipped": True}

    async def test_terminates_ffmpeg_and_closes_chamber_streams(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        running = SimpleNamespace(returncode=None, pid=101)
        finished = SimpleNamespace(returncode=0, pid=102)
        event = asyncio.Event()
        writer = MagicMock()
        broken_writer = MagicMock(close=MagicMock(side_effect=OSError("gone")))
        camera._active_streams.update({f"{printer.id}-a": running, f"{printer.id}-b": finished, "999-z": running})
        camera._spawned_ffmpeg_pids[101] = "x"
        camera._disconnect_events[f"{printer.id}-a"] = event
        camera._active_chamber_streams.update(
            {f"{printer.id}-c": (None, writer), f"{printer.id}-d": (None, broken_writer)}
        )
        terminate = AsyncMock()

        with (
            patch("backend.app.api.routes.camera.get_subscriber_count", return_value=0),
            patch("backend.app.api.routes.camera.shutdown_broadcaster", AsyncMock(return_value=True)),
            patch("backend.app.api.routes.camera._terminate_ffmpeg", terminate),
        ):
            body = (await async_client.get(f"/api/v1/printers/{printer.id}/camera/stop")).json()

        # One live ffmpeg plus one chamber stream closed cleanly.
        assert body == {"stopped": 2}
        terminate.assert_awaited_once_with(running, f"{printer.id}-a")
        assert event.is_set()
        writer.close.assert_called_once()
        assert list(camera._active_streams) == ["999-z"]
        assert camera._active_chamber_streams == {}
        assert 101 not in camera._spawned_ffmpeg_pids


class TestPlateReferences:
    BASE = "/api/v1/printers/{id}/camera/plate-detection/references/0"

    @pytest.fixture
    def detector(self):
        instance = MagicMock()
        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.PlateDetector", return_value=instance),
        ):
            yield instance

    async def test_thumbnail_label_and_delete(self, async_client: AsyncClient, printer_factory, detector):
        printer = await printer_factory()
        url = self.BASE.format(id=printer.id)
        detector.get_reference_thumbnail.return_value = b"jpg"
        detector.update_reference_label.return_value = True
        detector.delete_reference.return_value = True

        thumb = await async_client.get(f"{url}/thumbnail")
        label = await async_client.put(url, params={"label": "Empty bed"})
        deleted = await async_client.delete(url)

        assert (thumb.status_code, thumb.content, thumb.headers["content-type"]) == (200, b"jpg", "image/jpeg")
        assert label.json() == {"success": True, "index": 0, "label": "Empty bed"}
        assert deleted.json()["success"] is True

    async def test_missing_reference(self, async_client: AsyncClient, printer_factory, detector):
        printer = await printer_factory()
        url = self.BASE.format(id=printer.id)
        detector.get_reference_thumbnail.return_value = None
        detector.update_reference_label.return_value = False
        detector.delete_reference.return_value = False

        statuses = [
            (await async_client.get(f"{url}/thumbnail")).status_code,
            (await async_client.put(url, params={"label": "x"})).status_code,
            (await async_client.delete(url)).status_code,
        ]

        assert statuses == [404, 404, 404]

    async def test_plate_detection_unavailable(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        url = self.BASE.format(id=printer.id)

        with patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=False):
            statuses = [
                (await async_client.get(f"{url}/thumbnail")).status_code,
                (await async_client.put(url, params={"label": "x"})).status_code,
                (await async_client.delete(url)).status_code,
            ]

        assert statuses == [503, 503, 503]

    async def test_unknown_printer(self, async_client: AsyncClient, detector):
        assert (await async_client.delete(self.BASE.format(id=9999))).status_code == 404
