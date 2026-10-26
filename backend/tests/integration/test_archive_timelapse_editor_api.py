"""Timelapse editor endpoints: info, scrub thumbnails and processing.

The ffmpeg-backed TimelapseProcessor is replaced with a fake that records
how it was called.
"""

import base64
from unittest.mock import patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


class FakeProcessor:
    calls: list[dict] = []
    fail_with: Exception | None = None
    succeed = True

    def __init__(self, path):
        self.path = path

    async def get_info(self):
        if FakeProcessor.fail_with:
            raise FakeProcessor.fail_with
        return {
            "duration": 12.5,
            "width": 1920,
            "height": 1080,
            "fps": 30.0,
            "codec": "h264",
            "file_size": 1234,
            "has_audio": False,
        }

    async def generate_thumbnails(self, count, width):
        if FakeProcessor.fail_with:
            raise FakeProcessor.fail_with
        return [(i * 1.5, f"jpg{i}".encode()) for i in range(count)]

    async def process(self, output_path, **kwargs):
        if FakeProcessor.fail_with:
            raise FakeProcessor.fail_with
        FakeProcessor.calls.append({"output_path": output_path, **kwargs})
        if FakeProcessor.succeed:
            output_path.write_bytes(b"edited")
        return FakeProcessor.succeed


@pytest.fixture(autouse=True)
def processor():
    FakeProcessor.calls = []
    FakeProcessor.fail_with = None
    FakeProcessor.succeed = True
    with patch("backend.app.services.timelapse_processor.TimelapseProcessor", FakeProcessor):
        yield FakeProcessor


@pytest.fixture
async def archive(tmp_path, monkeypatch, printer_factory, archive_factory):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    (tmp_path / "archive/1/job").mkdir(parents=True)
    (tmp_path / "archive/1/job/timelapse.mp4").write_bytes(b"original")
    printer = await printer_factory()
    return await archive_factory(
        printer.id, print_name="Gear", file_path="archive/1/job/job.3mf", timelapse_path="archive/1/job/timelapse.mp4"
    )


class TestInfoAndThumbnails:
    async def test_info(self, async_client: AsyncClient, archive):
        response = await async_client.get(f"/api/v1/archives/{archive.id}/timelapse/info")

        assert response.json() == {
            "duration": 12.5,
            "width": 1920,
            "height": 1080,
            "fps": 30.0,
            "codec": "h264",
            "file_size": 1234,
            "has_audio": False,
        }

    async def test_thumbnails_are_base64(self, async_client: AsyncClient, archive):
        response = await async_client.get(f"/api/v1/archives/{archive.id}/timelapse/thumbnails", params={"count": 2})

        body = response.json()
        assert body["timestamps"] == [0.0, 1.5]
        assert [base64.b64decode(t) for t in body["thumbnails"]] == [b"jpg0", b"jpg1"]

    @pytest.mark.parametrize("endpoint", ["info", "thumbnails"])
    async def test_processor_errors(self, async_client: AsyncClient, archive, processor, endpoint):
        processor.fail_with = RuntimeError("ffprobe missing")

        response = await async_client.get(f"/api/v1/archives/{archive.id}/timelapse/{endpoint}")

        assert response.status_code == 500
        assert "ffprobe missing" in response.json()["detail"]

    @pytest.mark.parametrize("endpoint", ["info", "thumbnails"])
    async def test_missing_timelapse(self, async_client: AsyncClient, archive, tmp_path, endpoint, archive_factory):
        no_video = await archive_factory(archive.printer_id, timelapse_path=None)
        (tmp_path / archive.timelapse_path).unlink()

        assert (await async_client.get(f"/api/v1/archives/{no_video.id}/timelapse/{endpoint}")).status_code == 404
        assert (await async_client.get(f"/api/v1/archives/{archive.id}/timelapse/{endpoint}")).status_code == 404


class TestProcess:
    async def _process(self, client, archive, files=None, **form):
        return await client.post(f"/api/v1/archives/{archive.id}/timelapse/process", data=form, files=files)

    async def test_saves_edited_copy_next_to_the_original(
        self, async_client: AsyncClient, archive, processor, tmp_path
    ):
        response = await self._process(async_client, archive, trim_start="2", trim_end="10", speed="2")

        assert response.json() == {
            "status": "completed",
            "output_path": "archive/1/job/Gear_edited.mp4",
            "message": "Saved as Gear_edited.mp4",
        }
        [call] = processor.calls
        assert (call["trim_start"], call["trim_end"], call["speed"], call["audio_path"]) == (2.0, 10.0, 2.0, None)
        assert (tmp_path / "archive/1/job/timelapse.mp4").read_bytes() == b"original"

    @pytest.mark.parametrize(
        ("requested", "saved"),
        [
            ("my cut", "my cut.mp4"),
            ("../../etc/passwd", "timelapse_{id}_edited.mp4"),
            ("!!!", "timelapse_{id}_edited.mp4"),
        ],
    )
    async def test_output_filename_is_sanitised(self, async_client: AsyncClient, archive, requested, saved):
        response = await self._process(async_client, archive, output_filename=requested)

        assert response.json()["output_path"] == f"archive/1/job/{saved.format(id=archive.id)}"

    async def test_replace_overwrites_the_original(self, async_client: AsyncClient, archive, tmp_path):
        response = await self._process(async_client, archive, save_mode="replace")

        assert response.json()["message"] == "Timelapse replaced successfully"
        assert (tmp_path / "archive/1/job/timelapse.mp4").read_bytes() == b"edited"

    async def test_audio_overlay_is_passed_and_cleaned_up(self, async_client: AsyncClient, archive, processor):
        response = await self._process(async_client, archive, files={"audio": ("song.MP3", b"id3", "audio/mpeg")})

        assert response.status_code == 200
        audio_path = processor.calls[0]["audio_path"]
        assert audio_path.suffix == ".mp3"
        assert not audio_path.exists()

    @pytest.mark.parametrize(
        ("form", "files", "detail"),
        [
            ({"speed": "8"}, None, "Speed must be between 0.25 and 4.0"),
            ({"save_mode": "append"}, None, "save_mode must be 'replace' or 'new'"),
            ({}, {"audio": ("song.flac", b"x", "audio/flac")}, "Audio must be .mp3, .wav, .m4a, .aac, or .ogg"),
        ],
    )
    async def test_validation(self, async_client: AsyncClient, archive, form, files, detail):
        response = await self._process(async_client, archive, files=files, **form)

        assert (response.status_code, response.json()["detail"]) == (400, detail)

    async def test_processing_failure(self, async_client: AsyncClient, archive, processor):
        processor.succeed = False
        assert (await self._process(async_client, archive)).json()["detail"] == "Video processing failed"

        processor.fail_with = RuntimeError("ffmpeg crashed")
        response = await self._process(async_client, archive)
        assert (response.status_code, response.json()["detail"]) == (500, "Processing failed: ffmpeg crashed")

    async def test_missing_timelapse(self, async_client: AsyncClient, archive, tmp_path):
        (tmp_path / archive.timelapse_path).unlink()

        assert (await self._process(async_client, archive)).status_code == 404
        assert (await async_client.post("/api/v1/archives/9999/timelapse/process", data={})).status_code == 404
