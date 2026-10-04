"""Archive retries and object restoration during an already observed print."""

import asyncio
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.tests.unit.test_job_identity import add_linked_job, sessions  # noqa: F401


@pytest.mark.parametrize("recovering", [False, True])
@pytest.mark.parametrize("burst", [False, True])
@pytest.mark.parametrize("failure", ["write", "link", "link_then_id"])
async def test_mqtt_updates_retry_archive_write_without_repeating_start_effects(
    sessions, monkeypatch, tmp_path, recovering, burst, failure
):
    import backend.app.main as main
    from backend.app.core.tasks import _background_tasks
    from backend.app.services import bambu_ftp, usage_tracker
    from backend.app.services.bambu_mqtt import BambuMQTTClient

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
    monkeypatch.setattr(main, "async_session", failing_sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: client.state)
    monkeypatch.setattr(main.printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(main.printer_manager, "get_printer", lambda _id: None)
    monkeypatch.setattr(main, "_job_event_locks", {})
    monkeypatch.setattr(main, "_printer_reconciled_since_connect", {1: True})
    monkeypatch.setattr(main, "_printer_last_connected", {1: True})
    monkeypatch.setattr(main, "_last_status_broadcast", {})
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
    monkeypatch.setattr(main.ws_manager, "broadcast", AsyncMock())
    monkeypatch.setattr(main, "_capture_timelapse_baseline_at_start", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_print_start", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_archive_created", AsyncMock())
    started, notified, powered_on, usage = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(main.ws_manager, "send_print_start", started)
    monkeypatch.setattr(main, "_send_print_start_notification", notified)
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
        await asyncio.gather(*(t for t in tuple(_background_tasks) if t.get_name() == "retry-print-archive-1"))
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
    else:
        assert main._observed_job_starts.get(1) is None
    # Ordinary MQTT pushes, including identical status broadcasts, must drive
    # recovery. No direct second call to a print-start callback is made.
    assert await push("RUNNING", count=20 if burst else 1) == []
    assert await push("RUNNING") == []
    assert attempts == ([1, 1] if failure == "write" else [1])
    async with sessions() as db:
        job = await db.scalar(select(PrintQueueItem))
        archive = await db.get(PrintArchive, job.archive_id)
        assert archive is not None and archive.dispatched_queue_item_id == job.id
        assert archive.subtask_id == "external-run"
        assert main._observed_job_starts[1] == job.id
        assert 1 not in main._pending_archive_starts
        assert len(list(await db.scalars(select(PrintArchive)))) == 1
    for effect in (started, notified, powered_on, usage):
        assert effect.await_count == int(not recovering)


@pytest.mark.parametrize("guard", ["disconnected", "uninitialized", "foreign", "terminal", "busy"])
async def test_archive_retry_requires_a_fresh_matching_active_job(monkeypatch, guard):
    import backend.app.main as main
    from backend.app.services.bambu_mqtt import PrinterState

    live = PrinterState(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="run")
    pending = ("run", {"filename": "same.3mf"}, True)
    monkeypatch.setattr(main, "_pending_archive_starts", {1: pending})
    lock = asyncio.Lock()
    monkeypatch.setattr(main, "_job_event_locks", {1: lock})
    scheduled = []
    monkeypatch.setattr(main, "spawn_background_task", lambda coro, **kwargs: scheduled.append(coro))
    if guard == "disconnected":
        live.connected = False
    elif guard == "uninitialized":
        live.job_telemetry_ready = False
    elif guard == "foreign":
        live.submission_id = "another-run"
    elif guard == "terminal":
        live.state = "FINISH"
    else:
        await lock.acquire()
    try:
        main._schedule_pending_archive_retry(1, live)
        assert scheduled == []
        assert main._pending_archive_starts[1] == pending
    finally:
        if lock.locked():
            lock.release()


async def test_archive_retry_rechecks_identity_before_restoring_work(monkeypatch):
    import backend.app.main as main
    from backend.app.services.bambu_mqtt import PrinterState

    live = PrinterState(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="run")
    pending = ("run", {"filename": "same.3mf"}, True)
    monkeypatch.setattr(main, "_pending_archive_starts", {1: pending})
    monkeypatch.setattr(main, "_job_event_locks", {})
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    scheduled, observed = [], AsyncMock()
    monkeypatch.setattr(main, "spawn_background_task", lambda coro, **kwargs: scheduled.append(coro))
    monkeypatch.setattr(main, "_observe_print_start", observed)
    main._schedule_pending_archive_retry(1, live)
    main._schedule_pending_archive_retry(1, live)
    assert len(scheduled) == 1  # Claim the retry before the task starts.
    live.submission_id = "another-run"
    await scheduled[0]
    observed.assert_not_awaited()
    assert main._pending_archive_starts[1] == pending


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
