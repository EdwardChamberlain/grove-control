"""Scenario harness: the real app, a real database, simulated printers and a fake clock.

Scenarios drive the app only from outside, through the HTTP API and the
printers' reports. They assert only on what a user or a printer can observe:
job status and history, Archives, commands the printer received, files on its
SD card and notifications sent. Patching stops at the outer edges listed here
(FTP, camera, notifications, the clock), so internals can change freely.
"""

import asyncio
import hashlib
import sys
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import create_async_engine

from backend.tests.scenarios.fake_printer import FakePaho, FakePrinter

# -- time ------------------------------------------------------------------------


class FakeClock:
    """Virtual time. Sleeping advances it at once, so waits finish without real delay."""

    def __init__(self) -> None:
        self._base = datetime.now(timezone.utc)
        self._elapsed = 0.0

    def now(self) -> datetime:
        return self._base + timedelta(seconds=self._elapsed)

    def monotonic(self) -> float:
        return self._elapsed

    async def sleep(self, seconds: float) -> None:
        self._elapsed += max(0.0, seconds)
        await asyncio.sleep(0)

    def advance(self, seconds: float) -> None:
        self._elapsed += seconds


# -- outer edges ------------------------------------------------------------------


def _app_modules() -> list[ModuleType]:
    return [
        module
        for module in list(sys.modules.values())
        if isinstance(module, ModuleType) and (module.__name__ or "").startswith("backend.app")
    ]


def _replace_everywhere(monkeypatch, original: Any, replacement: Any, fakes: dict) -> None:
    """Rebind ``original`` in every loaded app module, wherever it was imported."""
    fakes[id(replacement)] = (replacement, original)
    for module in _app_modules():
        for name, value in list(vars(module).items()):
            if value is original:
                monkeypatch.setattr(module, name, replacement)


def _restore_everywhere(fakes: dict) -> None:
    """Undo fakes that modules imported during the scenario, which monkeypatch never saw."""
    for module in _app_modules():
        for name, value in list(vars(module).items()):
            entry = fakes.get(id(value))
            if entry is not None and entry[0] is value:
                setattr(module, name, entry[1])


@dataclass
class Notice:
    event: str
    args: tuple
    kwargs: dict


class SdCards:
    """Every printer's SD card, reached through the FTP functions."""

    def __init__(self, printers: dict[str, FakePrinter]):
        self._printers = printers

    def card(self, ip: str) -> dict[str, bytes]:
        return self._printers[ip].sd

    async def upload(self, ip, _access_code, local_path, remote_path, *_args, **_kwargs) -> bool:
        printer = self._printers[ip]
        printer.uploading += 1
        try:
            if printer.upload_gate is not None:
                await printer.upload_gate.wait()
            if not printer.accepts_uploads:
                return False
            printer.sd[remote_path] = Path(local_path).read_bytes()
            return True
        finally:
            printer.uploading -= 1

    async def delete(self, ip, _access_code, remote_path, *_args, **_kwargs):
        from backend.app.services.bambu_ftp import DeleteResult

        return DeleteResult.DELETED if self.card(ip).pop(remote_path, None) is not None else DeleteResult.NOT_FOUND

    async def download(self, ip, _access_code, remote_path, local_path, *_args, **_kwargs) -> bool:
        from backend.app.services.bambu_ftp import FileNotOnPrinterError

        printer = self._printers[ip]
        if printer.download_gate is not None:
            printer.downloading += 1
            try:
                await printer.download_gate.wait()
            finally:
                printer.downloading -= 1
        data = self.card(ip).get(remote_path)
        if data is None:
            raise FileNotOnPrinterError(remote_path)
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        Path(local_path).write_bytes(data)
        return True

    async def download_bytes(self, ip, _access_code, remote_path, *_args, **_kwargs) -> bytes | None:
        return self.card(ip).get(remote_path)

    async def listing(self, ip, _access_code, path="/", *_args, **_kwargs) -> list[dict]:
        prefix = path.rstrip("/") + "/"
        names = [name for name in self.card(ip) if name.startswith(prefix) or path == "/"]
        return [
            {"name": name.rsplit("/", 1)[-1], "size": len(self.card(ip)[name]), "is_directory": False} for name in names
        ]


# -- the harness ------------------------------------------------------------------


class Harness:
    """One isolated app: database, scheduler, printers, HTTP client and clock."""

    def __init__(self, tmp_path: Path, monkeypatch):
        self.tmp_path = tmp_path
        self.monkeypatch = monkeypatch
        self.clock = FakeClock()
        self.printers: dict[str, FakePrinter] = {}
        self.notices: list[Notice] = []
        self.plug_events: list[Notice] = []
        self.http: AsyncClient | None = None
        # Substrings of errors a scenario expects the app to log.
        self.allowed_errors: list[str] = []
        self._baseline_tasks: set[asyncio.Task] = set()
        self._fakes: dict = {}
        self._scenario_tasks: set[asyncio.Task] = set()

    # ---- lifecycle of the harness ----

    async def start(self) -> None:
        from backend.app.core import database
        from backend.app.core.config import settings
        from backend.app.services.lifecycle import clock

        self.monkeypatch.setattr(settings, "base_dir", self.tmp_path)
        self.monkeypatch.setattr(settings, "archive_dir", self.tmp_path / "archives")
        self._previous_clock = clock.use(self.clock)

        self.engine = create_async_engine(f"sqlite+aiosqlite:///{self.tmp_path / 'grove.db'}")
        event.listen(self.engine.sync_engine, "connect", database._set_sqlite_pragmas)
        self._previous_engine = database.engine
        database.engine = self.engine
        database.async_session.configure(bind=self.engine)
        await database.init_db()

        self._patch_edges()
        _forget_process_memory()
        self._baseline_tasks = set(asyncio.all_tasks())
        await self.boot()

        from backend.app.main import app

        self.http = AsyncClient(transport=ASGITransport(app=app), base_url="http://grove/api/v1")

    async def stop(self) -> None:
        from backend.app.core import database
        from backend.app.services.lifecycle import clock

        await self.shutdown()
        if self.http is not None:
            await self.http.aclose()
        database.async_session.configure(bind=self._previous_engine)
        database.engine = self._previous_engine
        clock.use(self._previous_clock)
        await self.engine.dispose()
        _restore_everywhere(self._fakes)

    def _patch_edges(self) -> None:
        from backend.app.services import bambu_ftp, camera
        from backend.app.services.notification_service import notification_service

        cards = SdCards(self.printers)
        for original, fake in (
            (bambu_ftp.upload_file_async, cards.upload),
            (bambu_ftp.delete_file_async, cards.delete),
            (bambu_ftp.download_file_async, cards.download),
            (bambu_ftp.download_file_bytes_async, cards.download_bytes),
            (bambu_ftp.list_files_async, cards.listing),
        ):
            _replace_everywhere(self.monkeypatch, original, fake, self._fakes)

        async def no_frame(*_args, **_kwargs):
            return None

        _replace_everywhere(self.monkeypatch, camera.capture_camera_frame_bytes, no_frame, self._fakes)

        from backend.app.services.smart_plug_manager import smart_plug_manager

        for name in ("on_print_start", "on_print_complete", "schedule_off_after_queue_job"):

            async def plug(*args, _event=name, **kwargs):
                self.plug_events.append(Notice(_event, args, kwargs))

            self.monkeypatch.setattr(smart_plug_manager, name, plug)

        for name in dir(notification_service):
            if name.startswith("on_") or name == "send_user_print_email":

                async def record(*args, _event=name, **kwargs):
                    self.notices.append(Notice(_event, args, kwargs))

                self.monkeypatch.setattr(notification_service, name, record)

        from backend.app import main

        # The offline notice waits out a reconnect in real time; it is an integration, not the lifecycle.
        self.monkeypatch.setattr(main, "_PRINTER_OFFLINE_NOTIFY_DEBOUNCE_SECONDS", 0)

        def connect(client, loop=None):
            printer = self.printers[client.ip_address]
            printer.client = client
            client._client = FakePaho(printer)
            client.state.connected = True

        from backend.app.services.bambu_mqtt import BambuMQTTClient

        self.monkeypatch.setattr(BambuMQTTClient, "connect", connect)

    # ---- the app process ----

    async def boot(self) -> None:
        """Start the app's lifecycle as ``main.lifespan`` does, on the current database."""
        from backend.app import main
        from backend.app.services import print_scheduler as scheduler_module
        from backend.app.services.printer_manager import printer_manager

        printer_manager.set_event_loop(asyncio.get_running_loop())
        printer_manager.set_status_change_callback(main.on_printer_status_change)
        printer_manager.set_print_start_callback(main.on_print_start)
        printer_manager.set_print_complete_callback(main.on_print_complete)
        printer_manager.set_print_running_observed_callback(main.on_print_running_observed)
        printer_manager.set_print_state_change_callback(main.on_print_state_change)
        printer_manager.set_finish_photo_moment_callback(main.on_finish_photo_moment)
        printer_manager.set_bed_temp_update_callback(main.intake.bed_cooled)
        await printer_manager.load_awaiting_plate_clear_from_db()

        self.scheduler = scheduler_module.PrintScheduler()
        self.monkeypatch.setattr(scheduler_module, "scheduler", self.scheduler)
        self.monkeypatch.setattr(main, "print_scheduler", self.scheduler)
        await self.scheduler.dispatcher.start()
        for printer in self.printers.values():
            await self._connect(printer)

    async def shutdown(self, abrupt: bool = False) -> None:
        """Stop the app: background work ends and in-process memory is lost.

        ``abrupt`` stops it mid-work, as a crash or power cut would.
        """
        from backend.app.services.printer_manager import printer_manager

        if not abrupt:
            await self.settle()
        for task in set(asyncio.all_tasks()) - self._baseline_tasks - {asyncio.current_task()}:
            task.cancel()
        for _ in range(5):
            await asyncio.sleep(0)
        for printer in self.printers.values():
            printer_manager.disconnect_printer(printer.printer_id)
        _forget_process_memory()

    async def restart(self, abrupt: bool = False) -> None:
        await self.shutdown(abrupt=abrupt)
        await self.boot()
        await self.settle()

    async def _connect(self, printer: FakePrinter) -> None:
        from backend.app.models.printer import Printer
        from backend.app.services import printer_manager as manager_module
        from backend.app.services.printer_manager import printer_manager

        async with self.session() as db:
            row = await db.get(Printer, printer.printer_id)
        with _instant_sleep(self.monkeypatch, manager_module):
            await printer_manager.connect_printer(row)
        # The first report after connecting never counts as a print start (#1304).
        printer.push()
        await self.settle()

    # ---- building the world ----

    def session(self):
        from backend.app.core.database import async_session

        return async_session()

    async def add_printer(self, name: str = "P1", model: str = "X1C") -> FakePrinter:
        from backend.app.models.printer import Printer

        ip = f"10.0.0.{len(self.printers) + 1}"
        async with self.session() as db:
            row = Printer(name=name, serial_number=f"SN{name}", ip_address=ip, access_code="code", model=model)
            db.add(row)
            await db.commit()
            printer = FakePrinter(printer_id=row.id, serial=row.serial_number, clock=self.clock)
        self.printers[ip] = printer
        await self._connect(printer)
        return printer

    async def add_file(self, name: str = "part.3mf") -> int:
        """A sliced 3MF in the File Manager; returns its library file id."""
        from backend.app.models.library import LibraryFile

        path = self.tmp_path / "library" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("Metadata/plate_1.gcode", ";HEADER_BLOCK_START\nG28\nM400\n; end\n")
        async with self.session() as db:
            row = LibraryFile(filename=name, file_path=str(path), file_type="3mf", file_size=path.stat().st_size)
            db.add(row)
            await db.commit()
            return row.id

    async def queue(self, printer: FakePrinter, file_id: int, **options: Any) -> int:
        """Add a job through the API, as the Queue page does; returns its id.

        Filament matching is not the lifecycle's concern, so jobs opt out of the
        colour check unless a scenario asks for it.
        """
        body = {"printer_id": printer.printer_id, "library_file_id": file_id, "force_color_match": False, **options}
        response = await self.http.post("/queue/", json=body)
        assert response.status_code == 200, response.text
        return response.json()["id"]

    async def action(self, job_id: int, name: str, **body: Any) -> Any:
        response = await self.http.post(f"/queue/{job_id}/{name}", json=body or None)
        return response

    # ---- running the app ----

    async def settle(self) -> None:
        """Let every piece of background work the app started run to completion."""
        for _ in range(200):
            for _ in range(5):
                await asyncio.sleep(0)
            pending = [
                task
                for task in asyncio.all_tasks()
                if task not in self._baseline_tasks
                and task not in self._scenario_tasks
                and task is not asyncio.current_task()
                and not task.done()
            ]
            if not pending:
                return
            await asyncio.wait(pending, timeout=0.05)
        stacks = "\n".join(f"{t.get_name()}: {t.get_coro()!r} at {t.get_stack(limit=3)}" for t in pending)
        raise AssertionError(f"background work never settled:\n{stacks}")

    async def run(self, rounds: int = 20) -> None:
        """Run the app's periodic work until nothing changes: scheduling, recovery and heat soaks."""
        from backend.app.core.database import run_with_retry
        from backend.app.services.lifecycle.intake import reconcile_print_archives

        previous = None
        for _ in range(rounds):
            await self.scheduler.check_queue()
            await self.settle()
            await run_with_retry(self.scheduler.dispatcher.recover, label="scenario recovery")
            await self.settle()
            async with self.session() as db:
                await self.scheduler._heat_soak.wait(db)
            await self.settle()
            await reconcile_print_archives()
            await self.settle()
            current = await self._fingerprint()
            if current == previous:
                return
            previous = current

    def spawn(self, work) -> asyncio.Task:
        """Run ``work`` concurrently, as a second user or request would; ``settle`` never waits for it."""
        task = asyncio.create_task(work)
        self._scenario_tasks.update((task, asyncio.current_task()))
        return task

    async def until(self, condition, attempts: int = 200) -> None:
        """Yield to the app until ``condition()`` (sync or async) holds."""
        for _ in range(attempts):
            result = condition()
            if asyncio.iscoroutine(result):
                result = await result
            if result:
                return
            await asyncio.sleep(0.01)
        raise AssertionError("condition never held")

    async def advance(self, seconds: float, tick: float = 30) -> None:
        """Let ``seconds`` of time pass, running the app's periodic work every ``tick`` as its timers would."""
        while seconds > 0:
            step = min(tick, seconds)
            self.clock.advance(step)
            seconds -= step
            await self.run()

    async def _fingerprint(self) -> str:
        from backend.app.models.archive import PrintArchive
        from backend.app.models.print_queue import PrintQueueItem

        async with self.session() as db:
            jobs = (
                await db.execute(select(PrintQueueItem.id, PrintQueueItem.status, PrintQueueItem.error_message))
            ).all()
            archives = (await db.execute(select(PrintArchive.id, PrintArchive.status))).all()
        commands = sum(len(printer.commands) for printer in self.printers.values())
        return hashlib.sha256(repr((jobs, archives, commands)).encode()).hexdigest()

    # ---- observing ----

    async def job(self, job_id: int) -> SimpleNamespace:
        from backend.app.models.print_queue import PrintQueueItem

        async with self.session() as db:
            row = await db.get(PrintQueueItem, job_id)
            return SimpleNamespace(**{column.key: getattr(row, column.key) for column in row.__table__.columns})

    async def jobs(self, printer: FakePrinter | None = None) -> list[SimpleNamespace]:
        from backend.app.models.print_queue import PrintQueueItem

        query = select(PrintQueueItem).order_by(PrintQueueItem.id)
        if printer is not None:
            query = query.where(PrintQueueItem.printer_id == printer.printer_id)
        async with self.session() as db:
            rows = list(await db.scalars(query))
            return [SimpleNamespace(**{c.key: getattr(r, c.key) for c in r.__table__.columns}) for r in rows]

    async def archives(self) -> list[SimpleNamespace]:
        from backend.app.models.archive import PrintArchive

        async with self.session() as db:
            rows = list(await db.scalars(select(PrintArchive).order_by(PrintArchive.id)))
            return [SimpleNamespace(**{c.key: getattr(r, c.key) for c in r.__table__.columns}) for r in rows]

    def notified(self, event_name: str) -> list[Notice]:
        return [notice for notice in self.notices if notice.event == event_name]


@contextmanager
def _instant_sleep(monkeypatch, module: ModuleType):
    """Skip ``connect_printer``'s one-second wait for a real broker."""
    real = module.asyncio

    async def no_wait(_seconds, *_args, **_kwargs):
        await real.sleep(0)

    proxy = SimpleNamespace(**{name: getattr(real, name) for name in dir(real) if not name.startswith("__")})
    proxy.sleep = no_wait
    monkeypatch.setattr(module, "asyncio", proxy)
    try:
        yield
    finally:
        monkeypatch.setattr(module, "asyncio", real)


def _forget_process_memory() -> None:
    """Drop everything the app keeps only in memory, as a restart would.

    Covers the lifecycle modules and the services its effects use. Mutable
    module globals are emptied, wake events are dropped and printer views
    are rebuilt from the database at boot.
    """
    import dataclasses

    from backend.app import main
    from backend.app.services import layer_timelapse, usage_tracker
    from backend.app.services.lifecycle import dispatching, intake, preheating
    from backend.app.services.printer_manager import printer_manager

    for module in (main, intake, preheating, dispatching, usage_tracker, layer_timelapse):
        for name, value in list(vars(module).items()):
            # Lower-case private containers are state; UPPER_CASE ones are constants.
            if isinstance(value, (dict, set, list)) and name[:1] == "_" and name[1:2].islower():
                value.clear()
            elif isinstance(value, asyncio.Event):
                setattr(module, name, None)
            elif dataclasses.is_dataclass(value) and not isinstance(value, type):
                for f in dataclasses.fields(value):
                    container = getattr(value, f.name)
                    if hasattr(container, "clear"):
                        container.clear()
    preheating._watched = None
    printer_manager._awaiting_plate_clear.clear()
    printer_manager._awaiting_plate_clear_archive_id.clear()
