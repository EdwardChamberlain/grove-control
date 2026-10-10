"""Paced Archive repair and runtime restoration for identified prints."""

import asyncio
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.lifecycle.engine import transition_queue_item, writer
from backend.tests.unit.test_job_identity import add_linked_job, sessions  # noqa: F401


@pytest.mark.parametrize("recovering", [False, True])
@pytest.mark.parametrize("burst", [False, True])
@pytest.mark.parametrize("failure", ["write", "link", "link_then_id"])
async def test_paced_reconciliation_repairs_archive_without_repeating_start_effects(
    sessions, monkeypatch, tmp_path, recovering, burst, failure
):
    import backend.app.main as main
    from backend.app.services import bambu_ftp, print_effects, usage_tracker
    from backend.app.services.bambu_mqtt import BambuMQTTClient
    from backend.app.services.lifecycle import intake

    attempts = []

    class FailFirstArchiveCommit(AsyncSession):
        async def commit(self):
            if any(isinstance(row, PrintArchive) for row in self.new):
                attempts.append(1)
                if failure == "write" and len(attempts) == 1:
                    raise RuntimeError("temporary archive write failure")
            return await super().commit()

    failing_sessions = async_sessionmaker(sessions.kw["bind"], class_=FailFirstArchiveCommit, expire_on_commit=False)
    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    client.state.connected = True
    monkeypatch.setattr(intake, "async_session", failing_sessions)
    monkeypatch.setattr(print_effects, "async_session", failing_sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: client.state)
    monkeypatch.setattr(main.printer_manager, "get_all_statuses", lambda: {1: client.state})
    monkeypatch.setattr(main.printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(main.printer_manager, "get_printer", lambda _id: None)
    monkeypatch.setattr(main, "_printer_last_connected", {1: True})
    monkeypatch.setattr(main, "_last_status_broadcast", {})
    monkeypatch.setattr(print_effects, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1)))
    monkeypatch.setattr(print_effects, "download_file_async", AsyncMock(return_value=False))
    monkeypatch.setattr(bambu_ftp, "list_files_async", AsyncMock(return_value=[]))
    monkeypatch.setattr(main.app_settings, "archive_dir", tmp_path / "archives")
    monkeypatch.setattr(main.app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(print_effects, "notify_missing_spool_assignments_on_print_start", AsyncMock())
    monkeypatch.setattr(print_effects, "_record_energy_start", AsyncMock())
    monkeypatch.setattr(print_effects, "_store_spoolman_print_data", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_created", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "broadcast", AsyncMock())
    monkeypatch.setattr(print_effects, "_capture_timelapse_baseline_at_start", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_print_start", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_archive_created", AsyncMock())
    started, notified, powered_on, usage = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(main.ws_manager, "send_print_start", started)
    monkeypatch.setattr(print_effects, "_send_print_start_notification", notified)
    monkeypatch.setattr(main.smart_plug_manager, "on_print_start", powered_on)
    monkeypatch.setattr(usage_tracker, "on_print_start", usage)
    callbacks = []
    client.on_print_start = lambda data: callbacks.append(asyncio.create_task(main.on_print_start(1, data)))
    client.on_print_running_observed = lambda data: callbacks.append(
        asyncio.create_task(main.on_print_running_observed(1, data))
    )
    client.on_state_change = lambda state: callbacks.append(
        asyncio.create_task(main.on_printer_status_change(1, state))
    )

    async def push(state, count=1, subtask_id="external-run"):
        for _ in range(count):
            client._process_message(
                {"print": {"gcode_state": state, "subtask_id": subtask_id, "gcode_file": "same.3mf"}}
            )
        results = await asyncio.gather(*callbacks, return_exceptions=True)
        callbacks.clear()
        return [result for result in results if isinstance(result, Exception)]

    failed_links = []

    def fail_link(connection, cursor, statement, parameters, context, executemany):
        sql = statement.lstrip().upper()
        if failure != "write" and not failed_links and sql.startswith("UPDATE PRINT_QUEUE") and "ARCHIVE_ID=" in sql:
            failed_links.append(statement)
            raise OperationalError(statement, parameters, Exception("temporary Archive link failure"))

    if not recovering:
        assert await push("IDLE") == []
    engine = sessions.kw["bind"]
    event.listen(engine.sync_engine, "before_cursor_execute", fail_link)
    try:
        errors = await push(
            "RUNNING" if recovering else "PREPARE", subtask_id="0" if failure == "link_then_id" else "external-run"
        )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", fail_link)
    assert attempts == [1]
    assert len(errors) == int(failure != "write")
    if errors:
        assert isinstance(errors[0], OperationalError)
    # Ordinary status pushes do not launch Archive retries, even in a burst.
    assert await push("RUNNING", count=20 if burst else 1) == []
    assert await push("RUNNING") == []
    assert attempts == [1]
    await intake.reconcile_print_archives()
    await intake.reconcile_print_archives()
    assert attempts == ([1, 1] if failure == "write" else [1])
    async with sessions() as db:
        job = await db.scalar(select(PrintQueueItem))
        archive = await db.get(PrintArchive, job.archive_id)
        assert archive is not None and archive.dispatched_queue_item_id == job.id
        assert archive.subtask_id == "external-run"
        assert intake._started_job_effects[1] == job.id
        assert len(list(await db.scalars(select(PrintArchive)))) == 1
    for effect in (started, notified, powered_on, usage):
        assert effect.await_count == int(not recovering)


@pytest.mark.parametrize("guard", ["disconnected", "uninitialized", "foreign", "not_started", "superseded"])
async def test_archive_reconciliation_requires_fresh_matching_started_job(sessions, monkeypatch, guard):
    from datetime import datetime, timezone

    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.lifecycle import intake

    live = PrinterState(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="run")
    job_id, _ = await add_linked_job(sessions, "run", with_archive=False)
    async with sessions() as db:
        job = await db.get(PrintQueueItem, job_id)
        job.started_at = None if guard == "not_started" else datetime.now(timezone.utc)
        await db.commit()
    monkeypatch.setattr(intake, "async_session", sessions)
    monkeypatch.setattr(print_effects, "async_session", sessions)
    monkeypatch.setattr(main.printer_manager, "get_all_statuses", lambda: {1: live})
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    repair = AsyncMock()
    monkeypatch.setattr(print_effects, "_archive_print_start", repair)
    if guard == "disconnected":
        live.connected = False
    elif guard == "uninitialized":
        live.job_telemetry_ready = False
    elif guard == "foreign":
        live.submission_id = "another-run"
    elif guard == "superseded":
        monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: None)
    await intake.reconcile_print_archives()
    repair.assert_not_awaited()


@pytest.mark.parametrize("archive_kind", ["linked", "unlinked", "downloaded"])
async def test_recovery_preserves_printer_reported_skipped_objects(sessions, monkeypatch, tmp_path, archive_kind):
    import backend.app.main as main
    from backend.app.services import archive as archive_service, print_effects
    from backend.app.services.lifecycle import intake

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
    monkeypatch.setattr(intake, "async_session", sessions)
    monkeypatch.setattr(print_effects, "async_session", sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(main.printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(main.app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(main.app_settings, "archive_dir", tmp_path / "archives")
    monkeypatch.setattr(print_effects, "_capture_timelapse_baseline_at_start", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_updated", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_created", AsyncMock())
    monkeypatch.setattr(print_effects, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1)))

    async def download(_ip, _code, _remote, local, **kwargs):
        local.write_bytes(source.read_bytes())
        return True

    monkeypatch.setattr(print_effects, "download_file_async", download)
    monkeypatch.setattr(
        archive_service, "extract_printable_objects_from_3mf", lambda *args, **kwargs: ([{"id": 1}, {"id": 2}], None)
    )
    await intake._observe_print_start(1, {"submission_id": "existing", "filename": "same.3mf"}, recovering=True)
    assert client.state.skipped_objects == [2]
    assert client.state.printable_objects == [{"id": 1}, {"id": 2}]
    async with sessions() as db:
        assert (await db.scalar(select(PrintQueueItem))).archive_id is not None


@pytest.mark.parametrize("state", ["FINISH", "RUNNING", "foreign", "uninitialized"])
async def test_late_archive_repair_preserves_terminal_facts_without_runtime_start(sessions, monkeypatch, state):
    from datetime import datetime, timezone

    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.lifecycle import intake

    job_id, archive_id = await add_linked_job(sessions, "run")
    async with sessions() as db:
        job = await db.get(PrintQueueItem, job_id)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "printing", "cancelled")
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "cancelled", "unsuccessful", action="clear_plate")
        job.archive_id = None
        job.started_at = datetime.now(timezone.utc)
        job.physical_outcome = "aborted"
        job.physical_completed_at = datetime.now(timezone.utc)
        job.physical_failure_reason = "User cancelled"
        (await db.get(PrintArchive, archive_id)).status = "printing"  # Archive creation finished after Clear Plate.
        await db.commit()
    live = PrinterState(
        connected=True, job_telemetry_ready=True, state=state, submission_id="run", gcode_file="same.3mf"
    )
    if state == "foreign":
        live.submission_id = "another-run"
    elif state == "uninitialized":
        live.job_telemetry_ready = False
    monkeypatch.setattr(intake, "async_session", sessions)
    monkeypatch.setattr(print_effects, "async_session", sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(main.printer_manager, "get_all_statuses", lambda: {1: live})
    new_start, layer_video, objects = AsyncMock(), MagicMock(), MagicMock()
    monkeypatch.setattr(print_effects, "_begin_new_print", new_start)
    monkeypatch.setattr(print_effects, "_maybe_start_layer_timelapse", layer_video)
    monkeypatch.setattr(print_effects, "_load_objects_from_archive", objects)
    monkeypatch.setattr(main.ws_manager, "send_archive_updated", AsyncMock())
    await intake.reconcile_print_archives()
    new_start.assert_not_awaited()
    layer_video.assert_not_called()
    objects.assert_not_called()
    async with sessions() as db:
        job = await db.get(PrintQueueItem, job_id)
        archive = await db.get(PrintArchive, archive_id)
        if state in ("FINISH", "RUNNING"):
            assert job.archive_id == archive_id
            assert archive.status == "aborted" and archive.failure_reason == "User cancelled"
            assert archive.completed_at == job.physical_completed_at
        else:
            assert job.archive_id is None and archive.status == "printing"


async def test_failed_archive_write_reuses_download_in_paced_repair(sessions, monkeypatch, tmp_path):
    from datetime import datetime, timezone

    import backend.app.main as main
    from backend.app.services import bambu_ftp, print_effects
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.lifecycle import intake

    job_id, _ = await add_linked_job(sessions, "run", with_archive=False)
    async with sessions() as db:
        (await db.get(PrintQueueItem, job_id)).started_at = datetime.now(timezone.utc)
        await db.commit()
    commits = []

    class FailOnce(AsyncSession):
        async def commit(self):
            if any(isinstance(row, PrintArchive) for row in self.new):
                commits.append(1)
                if len(commits) == 1:
                    raise RuntimeError("temporary write failure")
            return await super().commit()

    maker = async_sessionmaker(sessions.kw["bind"], class_=FailOnce, expire_on_commit=False)
    live = PrinterState(
        connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="run", gcode_file="same.3mf"
    )
    monkeypatch.setattr(intake, "async_session", maker)
    monkeypatch.setattr(print_effects, "async_session", maker)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(main.printer_manager, "get_all_statuses", lambda: {1: live})
    monkeypatch.setattr(main.printer_manager, "get_client", lambda _id: None)
    monkeypatch.setattr(main.app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(main.app_settings, "archive_dir", tmp_path / "archives")
    monkeypatch.setattr(print_effects, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1)))
    monkeypatch.setattr(bambu_ftp, "_threemf_path_cache", {})
    monkeypatch.setattr(print_effects, "_capture_timelapse_baseline_at_start", AsyncMock())
    monkeypatch.setattr(main.ws_manager, "send_archive_created", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_archive_created", AsyncMock())

    async def download(_ip, _code, _remote, local, **kwargs):
        with zipfile.ZipFile(local, "w") as source:
            source.writestr("Metadata/plate_1.gcode", "G28\nM400\n")
        return True

    copied = AsyncMock(side_effect=download)
    monkeypatch.setattr(print_effects, "download_file_async", copied)
    await intake.reconcile_print_archives()
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, job_id)).archive_id is None
    await intake.reconcile_print_archives()
    await intake.reconcile_print_archives()
    copied.assert_awaited_once()
    assert commits == [1, 1]
    async with sessions() as db:
        job = await db.get(PrintQueueItem, job_id)
        assert job.archive_id is not None
        assert len(list(await db.scalars(select(PrintArchive)))) == 1
