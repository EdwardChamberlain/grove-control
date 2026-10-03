"""Archive retries and object restoration during an already observed print."""

import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.tests.unit.test_job_identity import add_linked_job, sessions  # noqa: F401


@pytest.mark.parametrize("recovering", [False, True])
async def test_real_fallback_write_failure_retries_archive_without_repeating_start_effects(
    sessions, monkeypatch, tmp_path, recovering
):
    import backend.app.main as main
    from backend.app.services import bambu_ftp, usage_tracker

    attempts = []

    class FailFirstArchiveCommit(AsyncSession):
        async def commit(self):
            if any(isinstance(row, PrintArchive) for row in self.new):
                attempts.append(1)
                if len(attempts) == 1:
                    raise RuntimeError("temporary archive write failure")
            return await super().commit()

    failing_sessions = async_sessionmaker(sessions.kw["bind"], class_=FailFirstArchiveCommit, expire_on_commit=False)
    live = SimpleNamespace(state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="external-run")
    monkeypatch.setattr(main, "async_session", failing_sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(main, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1)))
    monkeypatch.setattr(main, "download_file_async", AsyncMock(return_value=False))
    monkeypatch.setattr(bambu_ftp, "list_files_async", AsyncMock(return_value=[]))
    monkeypatch.setattr(main.app_settings, "archive_dir", tmp_path / "archives")
    monkeypatch.setattr(main.app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(main, "_active_prints", {})
    monkeypatch.setattr(main, "notify_missing_spool_assignments_on_print_start", AsyncMock())
    monkeypatch.setattr(main, "_record_energy_start", AsyncMock())
    monkeypatch.setattr(main, "_store_spoolman_print_data", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_created", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_print_start", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_archive_created", AsyncMock())
    started, notified, powered_on, usage = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(main.ws_manager, "send_print_start", started)
    monkeypatch.setattr(main, "_send_print_start_notification", notified)
    monkeypatch.setattr(main.smart_plug_manager, "on_print_start", powered_on)
    monkeypatch.setattr(usage_tracker, "on_print_start", usage)
    data = {"submission_id": "external-run", "filename": "same.3mf", "raw_data": {"gcode_state": "RUNNING"}}
    await main._observe_print_start(1, data, recovering=recovering)
    assert attempts == [1] and main._observed_job_starts.get(1) is None
    await main._observe_print_start(1, data, recovering=recovering)
    await main._observe_print_start(1, data, recovering=recovering)
    assert attempts == [1, 1]
    async with sessions() as db:
        job = await db.scalar(select(PrintQueueItem))
        archive = await db.get(PrintArchive, job.archive_id)
        assert archive is not None and archive.dispatched_queue_item_id == job.id
        assert archive.subtask_id == "external-run"
        assert main._observed_job_starts[1] == job.id
        assert len(list(await db.scalars(select(PrintArchive)))) == 1
    for effect in (started, notified, powered_on, usage):
        assert effect.await_count == int(not recovering)


@pytest.mark.parametrize("archive_kind", ["linked", "unlinked", "downloaded"])
async def test_recovery_preserves_printer_reported_skipped_objects(sessions, monkeypatch, tmp_path, archive_kind):
    import backend.app.main as main
    from backend.app.services import archive as archive_service

    _, archive_id = await add_linked_job(sessions, "existing", with_archive=archive_kind != "downloaded")
    source = tmp_path / "same.3mf"
    with zipfile.ZipFile(source, "w") as file:
        file.writestr("Metadata/plate_1.gcode", "G28\nM400\n")
    async with sessions() as db:
        if archive_id is not None:
            archive = await db.get(PrintArchive, archive_id)
            archive.file_path = str(source)
            if archive_kind == "unlinked":
                archive.dispatched_queue_item_id = None
                (await db.scalar(select(PrintQueueItem))).archive_id = None
        await db.commit()
    client = SimpleNamespace(
        state=SimpleNamespace(skipped_objects=[2], printable_objects=[], printable_objects_bbox_all=None)
    )
    live = SimpleNamespace(state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="existing")
    monkeypatch.setattr(main, "async_session", sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(main.printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(main.app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(main.app_settings, "archive_dir", tmp_path / "archives")
    monkeypatch.setattr(main, "_capture_timelapse_baseline_at_start", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_updated", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_created", AsyncMock())
    monkeypatch.setattr(main, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1)))

    async def download(_ip, _code, _remote, local, **kwargs):
        local.write_bytes(source.read_bytes())
        return True

    monkeypatch.setattr(main, "download_file_async", download)
    monkeypatch.setattr(
        archive_service, "extract_printable_objects_from_3mf", lambda *args, **kwargs: ([{"id": 1}, {"id": 2}], None)
    )
    await main._observe_print_start(1, {"submission_id": "existing", "filename": "same.3mf"}, recovering=True)
    assert client.state.skipped_objects == [2]
    assert client.state.printable_objects == [{"id": 1}, {"id": 2}]
    async with sessions() as db:
        assert (await db.scalar(select(PrintQueueItem))).archive_id is not None
