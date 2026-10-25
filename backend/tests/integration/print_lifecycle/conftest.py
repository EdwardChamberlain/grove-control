"""Shared setup for print lifecycle tests (issue #256, phase 1).

The lifecycle callbacks in ``backend.app.main`` run against the real test
database and real archive storage under ``tmp_path``. Only the edges are
faked: the printer's FTP file system, the MQTT printer client, websockets,
notifications, the MQTT relay and smart plugs.
"""

import asyncio
import io
import json
import zipfile
from dataclasses import dataclass, field
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app import main
from backend.app.core.config import settings as app_settings
from backend.app.services import bambu_ftp
from backend.app.services.bambu_ftp import FileNotOnPrinterError

# Module-level state the callbacks keep between start and completion.
_MAIN_STATE = (
    "_active_prints",
    "_expected_prints",
    "_expected_print_registered_at",
    "_expected_print_creators",
    "_print_ams_mappings",
    "_print_plate_ids",
    "_user_stopped_printers",
    "_bed_cool_waiters",
    "_stage22_finish_frames",
    "_timelapse_baselines",
    "_last_status_broadcast",
    "_last_progress_milestone",
    "_first_layer_notified",
    "_notified_hms_errors",
    "_hms_last_seen",
    "_nozzle_count_updated",
    "_printer_reconciled_since_connect",
    "_pending_stale_reconciliation",
    "_printer_last_connected",
    "_printer_offline_notify_tasks",
    "_ams_alarm_cooldown",
)


def make_3mf(
    *,
    plate_index: int = 1,
    print_time: int = 3600,
    weight: float = 12.5,
    objects: tuple[tuple[int, str], ...] = ((101, "Cube"), (102, "Gear")),
    filament_type: str = "PLA",
    filament_color: str = "#FF0000",
) -> bytes:
    """Build a minimal sliced Bambu 3MF that the archive parser accepts."""
    object_xml = "".join(f'<object identify_id="{oid}" name="{name}" skipped="false"/>' for oid, name in objects)
    slice_info = (
        "<config><plate>"
        f'<metadata key="index" value="{plate_index}"/>'
        f'<metadata key="prediction" value="{print_time}"/>'
        f'<metadata key="weight" value="{weight}"/>'
        f"{object_xml}"
        f'<filament id="1" type="{filament_type}" color="{filament_color}" used_m="4.2" used_g="{weight}"/>'
        "</plate></config>"
    )
    plate_json = {
        "bbox_all": [0, 0, 100, 100],
        "bbox_objects": [{"name": name, "bbox": [10, 10, 30, 30]} for _, name in objects],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr("Metadata/slice_info.config", slice_info)
        zf.writestr(f"Metadata/plate_{plate_index}.gcode", "G28\nG1 X10 Y10\n")
        zf.writestr(f"Metadata/plate_{plate_index}.json", json.dumps(plate_json))
    return buf.getvalue()


@dataclass
class FakePrinterStorage:
    """The printer's SD card as seen over FTP: remote path -> bytes."""

    files: dict[str, bytes] = field(default_factory=dict)
    download_attempts: list[str] = field(default_factory=list)
    listed_dirs: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)

    async def download(self, ip, access_code, remote_path, local_path, **kwargs):
        self.download_attempts.append(remote_path)
        if remote_path not in self.files:
            raise FileNotOnPrinterError(remote_path)
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(self.files[remote_path])
        return True

    async def list_dir(self, ip, access_code, path="/", **kwargs):
        self.listed_dirs.append(path)
        prefix = path.rstrip("/") + "/"
        entries = []
        for remote in self.files:
            if remote.startswith(prefix) and "/" not in remote[len(prefix) :]:
                entries.append({"name": remote[len(prefix) :], "is_directory": False, "size": len(self.files[remote])})
        return entries

    async def delete(self, ip, access_code, remote_path, **kwargs):
        if remote_path in self.files:
            del self.files[remote_path]
            self.deleted.append(remote_path)
            return bambu_ftp.DeleteResult.DELETED
        return bambu_ftp.DeleteResult.NOT_FOUND


@dataclass
class LifecycleEnv:
    session: async_sessionmaker
    storage: FakePrinterStorage
    ws: AsyncMock
    notifications: AsyncMock
    relay: AsyncMock
    plugs: AsyncMock
    printer_manager: MagicMock
    client: MagicMock
    base_dir: object
    background_tasks_at_start: set[asyncio.Task] = field(default_factory=set)
    background_task_errors: dict[asyncio.Task, BaseException] = field(default_factory=dict)

    async def add(self, *rows):
        async with self.session() as db:
            for row in rows:
                db.add(row)
            await db.commit()
            for row in rows:
                await db.refresh(row)
        return rows[0] if len(rows) == 1 else rows

    async def get(self, model, pk):
        async with self.session() as db:
            return await db.get(model, pk)

    async def all(self, model):
        from sqlalchemy import select

        async with self.session() as db:
            return list((await db.execute(select(model))).scalars().all())

    async def drain(self, timeout: float = 10.0):
        """Wait for callback tasks and fail if any task raised unexpectedly."""
        from backend.app.core import tasks

        async def _wait():
            while current := tuple(set(tasks._background_tasks) - self.background_tasks_at_start):
                results = await asyncio.gather(*current, return_exceptions=True)
                for task, result in zip(current, results, strict=True):
                    if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                        self.background_task_errors[task] = result
                await asyncio.sleep(0)

        await asyncio.wait_for(_wait(), timeout)
        failures = list(self.background_task_errors.items())
        self.background_task_errors.clear()
        if failures:
            details = "\n".join(f"- {task.get_name()}: {type(error).__name__}: {error}" for task, error in failures)
            raise AssertionError(f"Lifecycle background task(s) failed:\n{details}") from failures[0][1]

    async def cleanup_background_tasks(self):
        """Cancel leftovers and surface failures from tasks the test did not drain."""
        from backend.app.core import tasks

        failures = []
        pending = []
        state_tasks = tuple(main._printer_offline_notify_tasks.values())
        for task in state_tasks:
            if not task.done():
                task.cancel()
        if state_tasks:
            done, state_pending = await asyncio.wait(state_tasks, timeout=1.0)
            pending.extend(task.get_name() for task in state_pending)
            for task in done:
                if task.cancelled():
                    continue
                error = task.exception()
                if error is not None:
                    failures.append((task.get_name(), error))

        deadline = asyncio.get_running_loop().time() + 1.0
        while current := set(tasks._background_tasks) - self.background_tasks_at_start:
            for task in current:
                if not task.done():
                    task.cancel()
            timeout = max(0.0, deadline - asyncio.get_running_loop().time())
            _, still_pending = await asyncio.wait(current, timeout=timeout)
            pending.extend(task.get_name() for task in still_pending)
            if still_pending:
                break
            # A cancelled task may spawn cleanup work from its finally block.
            await asyncio.sleep(0)

        failures.extend((task.get_name(), error) for task, error in self.background_task_errors.items())
        self.background_task_errors.clear()
        if failures or pending:
            details = [f"- {name}: {type(error).__name__}: {error}" for name, error in failures]
            details.extend(f"- {name}: still pending after cancellation" for name in pending)
            raise AssertionError("Lifecycle background task cleanup failed:\n" + "\n".join(details)) from (
                failures[0][1] if failures else None
            )

    async def set_setting(self, key: str, value: str):
        from backend.app.models.settings import Settings

        await self.add(Settings(key=key, value=value))

    async def make_archive(self, printer_id, **kwargs):
        from backend.app.models.archive import PrintArchive

        defaults = {
            "printer_id": printer_id,
            "filename": "Benchy.gcode.3mf",
            "print_name": "Benchy",
            "file_path": "",
            "file_size": 0,
            "status": "printing",
            "print_time_seconds": 3600,
        }
        defaults.update(kwargs)
        return await self.add(PrintArchive(**defaults))

    async def make_printer(self, **kwargs):
        from backend.app.models.printer import Printer

        defaults = {
            "name": "Lifecycle Printer",
            "serial_number": "00M09A000000901",
            "ip_address": "192.168.1.90",
            "access_code": "12345678",
            "is_active": True,
            "auto_archive": True,
            "model": "X1C",
        }
        defaults.update(kwargs)
        return await self.add(Printer(**defaults))


def _serialised_spawner():
    """spawn_background_task that runs tasks one at a time, in spawn order.

    The test database is one shared in-memory SQLite connection, so
    background tasks committing concurrently fail with "SQL statements in
    progress". Production uses a connection per session, so serialising here
    only removes a test-environment artefact. Tasks still start in the order
    the callback spawns them (asyncio.Lock is FIFO), so a task that awaits an
    earlier one (notifications waiting on the finish photo) still works.
    """
    from backend.app.core.tasks import spawn_background_task

    lock = asyncio.Lock()

    def spawn(coro, *, name=None):
        async def _run():
            async with lock:
                return await coro

        return spawn_background_task(_run(), name=name)

    return spawn


@pytest.fixture
async def lifecycle(test_engine, tmp_path, monkeypatch):
    from backend.app.core import tasks

    session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    storage = FakePrinterStorage()
    background_tasks_at_start = set(tasks._background_tasks)
    background_task_errors = {}
    original_task_done = tasks._on_task_done

    def track_task_done(task):
        if task not in background_tasks_at_start and not task.cancelled():
            error = task.exception()
            if error is not None:
                background_task_errors[task] = error
        original_task_done(task)

    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")
    (tmp_path / "archive").mkdir()

    client = MagicMock()
    client.state = SimpleNamespace(
        chamber_light=True,
        printable_objects={},
        printable_objects_bbox_all=None,
        skipped_objects=[],
        progress=0.0,
        state="RUNNING",
        bed_temper=60.0,
    )
    client.last_dispatch_subtask_id = None

    printer_manager = MagicMock()
    printer_manager.get_client.return_value = client
    printer_manager.get_status.return_value = None
    printer_manager.get_printer.return_value = SimpleNamespace(name="Lifecycle Printer", serial_number="SN1")
    printer_manager.get_current_print_user.return_value = None

    env = LifecycleEnv(
        session=session,
        storage=storage,
        ws=AsyncMock(),
        notifications=AsyncMock(),
        relay=AsyncMock(),
        plugs=AsyncMock(),
        printer_manager=printer_manager,
        client=client,
        base_dir=tmp_path,
        background_tasks_at_start=background_tasks_at_start,
        background_task_errors=background_task_errors,
    )
    env.notifications._get_providers_for_event.return_value = []

    _reset_state()

    with (
        patch("backend.app.main.async_session", session),
        patch("backend.app.core.database.async_session", session),
        patch("backend.app.core.tasks._on_task_done", track_task_done),
        patch("backend.app.main.spawn_background_task", _serialised_spawner()),
        patch("backend.app.main.ws_manager", env.ws),
        patch("backend.app.main.notification_service", env.notifications),
        patch("backend.app.main.mqtt_relay", env.relay),
        patch("backend.app.main.smart_plug_manager", env.plugs),
        patch("backend.app.main.printer_manager", printer_manager),
        patch("backend.app.main.notify_missing_spool_assignments_on_print_start", AsyncMock()),
        patch("backend.app.main._capture_snapshot_for_notification", AsyncMock(return_value=None)),
        patch("backend.app.main.get_ftp_retry_settings", AsyncMock(return_value=(False, 1, 0.0, 5.0))),
        patch("backend.app.main.download_file_async", storage.download),
        patch("backend.app.services.bambu_ftp.list_files_async", storage.list_dir),
        patch("backend.app.services.bambu_ftp.delete_file_async", storage.delete),
        # Completion side effects that would reach cameras or encode video.
        patch("backend.app.services.camera.capture_finish_photo", AsyncMock(return_value=None)),
        patch("backend.app.services.layer_timelapse.on_print_complete", AsyncMock(return_value=None)),
        patch("backend.app.main._scan_for_timelapse_with_retries", AsyncMock()),
    ):
        try:
            yield env
        finally:
            try:
                await env.cleanup_background_tasks()
            finally:
                _reset_state()


def _reset_state():
    from backend.app.services import usage_tracker

    for task in main._printer_offline_notify_tasks.values():
        task.cancel()
    for name in _MAIN_STATE:
        getattr(main, name).clear()
    usage_tracker._active_sessions.clear()
    bambu_ftp.clear_3mf_cache(None, delete_files=False)
