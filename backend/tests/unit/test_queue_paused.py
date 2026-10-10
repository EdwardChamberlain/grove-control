"""Stage 4 pause/resume observations use the real identity and lifecycle writers."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import effects as lifecycle_effects
from backend.app.services.lifecycle.engine import QueueTransitionConflict, transition_queue_item, writer
from backend.app.services.lifecycle.printing import bind_observed_id, observe_print, sync_print_state
from backend.app.services.print_scheduler import PrintScheduler


@pytest.fixture
async def sessions(tmp_path):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    intake._started_job_effects.clear()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'paused.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(Printer(id=1, name="Printer", serial_number="TEST", ip_address="127.0.0.1", access_code="code"))
        await db.commit()
    yield maker
    await engine.dispose()


def telemetry(state="PAUSE", identity="123", **kwargs):
    return SimpleNamespace(connected=True, job_telemetry_ready=True, state=state, submission_id=identity, **kwargs)


async def add_job(sessions, status="printing", identity="123"):
    async with sessions() as db:
        item = PrintQueueItem(
            printer_id=1,
            status=status,
            dispatch_subtask_id=identity,
            started_at=None if status == "dispatching" else datetime.now(timezone.utc) - timedelta(minutes=5),
            dispatched_at=datetime.now(timezone.utc) - timedelta(minutes=10),
        )
        db.add(item)
        await db.flush()
        archive = PrintArchive(
            printer_id=1,
            dispatched_queue_item_id=item.id,
            filename="same.3mf",
            file_path="",
            file_size=0,
            status="printing",
            subtask_id=identity,
        )
        db.add(archive)
        await db.flush()
        item.archive_id = archive.id
        await db.commit()
        return item.id, archive.id


@pytest.mark.parametrize("initial", ["dispatching", "printing", "external"])
async def test_pause_observation_keeps_the_same_job_and_archive(sessions, initial):
    item_id = archive_id = None
    if initial != "external":
        item_id, archive_id = await add_job(sessions, initial)
    async with sessions() as db:
        item, confirmed = await observe_print(db, 1, "123", observed_state=telemetry())
        await db.commit()
        assert item.status == "paused"
        assert confirmed == (initial == "dispatching")
        assert item_id is None or item.id == item_id
        assert item.archive_id == archive_id
        assert item.started_at is not None
        started_at = item.started_at
        for state in ("PAUSE", "RUNNING", "RUNNING", "PAUSE"):
            observed, confirmed = await observe_print(db, 1, "123", observed_state=telemetry(state))
            await db.commit()
            assert observed.id == item.id
            assert not confirmed
            assert observed.status == ("paused" if state == "PAUSE" else "printing")
            assert observed.started_at == started_at
        assert len((await db.scalars(select(PrintQueueItem))).all()) == 1
        if archive_id:
            assert (await db.get(PrintArchive, archive_id)).status == "printing"


async def test_late_firmware_identity_binds_a_paused_external_job_and_archive(sessions):
    item_id, archive_id = await add_job(sessions, "paused", "local-session")
    async with sessions() as db:
        await bind_observed_id(db, 1, "123", "local-session")
        await db.commit()
        item = await db.get(PrintQueueItem, item_id)
        archive = await db.get(PrintArchive, archive_id)
        assert item.status == "paused"
        assert item.dispatch_subtask_id == archive.subtask_id == "123"


@pytest.mark.parametrize(
    ("initial", "state", "expected"),
    [
        ("dispatching", "PAUSE", "paused"),
        ("printing", "PAUSE", "paused"),
        ("paused", "RUNNING", "printing"),
        ("paused", "PREPARE", "paused"),
        ("paused", "SLICING", "paused"),
    ],
)
async def test_restart_recovery_applies_pause_resume_without_restarting_the_job(sessions, initial, state, expected):
    item_id, archive_id = await add_job(sessions, initial)
    scheduler = PrintScheduler()
    publish = AsyncMock()
    tasks = []

    def spawn(coro, **kwargs):
        tasks.append(coro)

    with (
        patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", return_value=telemetry(state)),
        patch("backend.app.services.lifecycle.dispatching.spawn_background_task", side_effect=spawn),
        patch.object(lifecycle_effects, "publish_queue_job_started", publish),
    ):
        async with sessions() as db:
            before = (await db.get(PrintQueueItem, item_id)).started_at
            await scheduler.dispatcher.recover(db)
        for task in tasks:
            await task
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.status == expected
        assert item.started_at is not None
        assert before is None or item.started_at == before
        assert item.archive_id == archive_id
        assert (await db.get(PrintArchive, archive_id)).status == "printing"
    assert publish.await_count == (1 if initial == "dispatching" else 0)


@pytest.mark.parametrize("invalid", ["wrong_id", "no_id", "offline", "uninitialized", "terminal", "prepare"])
async def test_unsafe_telemetry_cannot_resume_a_paused_job(sessions, invalid):
    item_id, _ = await add_job(sessions, "paused")
    live = telemetry("RUNNING")
    if invalid == "wrong_id":
        live.submission_id = "other"
    elif invalid == "no_id":
        live.submission_id = None
    elif invalid == "offline":
        live.connected = False
    elif invalid == "uninitialized":
        live.job_telemetry_ready = False
    elif invalid == "terminal":
        live.state = "FINISH"
    else:
        live.state = "PREPARE"
    async with sessions() as db:
        assert not await sync_print_state(db, await db.get(PrintQueueItem, item_id), live)
        await db.commit()
        assert (await db.get(PrintQueueItem, item_id)).status == "paused"


async def test_cancel_winning_a_pause_observation_cannot_be_overwritten(sessions):
    item_id, archive_id = await add_job(sessions)
    async with sessions() as stale:
        item = await stale.get(PrintQueueItem, item_id)
        async with sessions() as cancel:
            current = await cancel.get(PrintQueueItem, item_id)
            async with writer(getattr(current, "printer_id", None) or getattr(current, "assigned_printer_id", None)):
                await transition_queue_item(cancel, current, "printing", "cancelled")
            await cancel.commit()
        with pytest.raises(QueueTransitionConflict):
            await sync_print_state(stale, item, telemetry())
        await stale.rollback()
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.status == "cancelled" and item.archive_id == archive_id


@pytest.mark.parametrize(
    ("initial", "state"),
    [("dispatching", "RUNNING"), ("printing", "PAUSE"), ("paused", "RUNNING")],
)
async def test_print_start_skips_a_stop_that_wins_after_the_job_is_read(sessions, initial, state):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    item_id, archive_id = await add_job(sessions, initial)
    async with sessions() as stale:
        item = await stale.get(PrintQueueItem, item_id)
        started_at = item.started_at
        async with sessions() as cancel:
            current = await cancel.get(PrintQueueItem, item_id)
            async with writer(getattr(current, "printer_id", None) or getattr(current, "assigned_printer_id", None)):
                await transition_queue_item(cancel, current, initial, "cancelled")
            await cancel.commit()
        # SQLite serializes writers at the printer lock. Supply the pre-Stop
        # snapshot to exercise the stale-read conflict possible on PostgreSQL.
        with (
            patch.object(intake, "async_session", return_value=stale),
            patch.object(print_effects, "async_session", return_value=stale),
            patch.object(main.printer_manager, "get_status", return_value=telemetry(state)),
            patch("backend.app.services.job_identity.find_job", AsyncMock(return_value=item)),
            patch.object(print_effects, "_archive_print_start", AsyncMock()) as archive_start,
            patch.object(lifecycle_effects, "publish_queue_job_started", AsyncMock()) as publish,
        ):
            await main.on_print_start(1, {"submission_id": "123", "filename": "same.3mf"})
            archive_start.assert_not_awaited()
            publish.assert_not_awaited()
            assert 1 not in intake._started_job_effects
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.status == "cancelled"
        assert item.started_at == started_at
        assert item.archive_id == archive_id
        assert len((await db.scalars(select(PrintQueueItem))).all()) == 1


@pytest.mark.parametrize(
    ("observed", "live", "identity"),
    [
        ("PAUSE", "RUNNING", "123"),
        ("RUNNING", "PAUSE", "123"),
        ("PAUSE", "PAUSE", "other"),
    ],
)
async def test_delayed_callback_cannot_apply_a_superseded_snapshot(sessions, observed, live, identity):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    initial = "printing" if observed == "PAUSE" else "paused"
    item_id, _ = await add_job(sessions, initial)
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(main.printer_manager, "get_status", return_value=telemetry(live, identity)),
    ):
        await main.on_print_state_change(1, {"submission_id": "123", "state": observed})
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == initial


@pytest.mark.parametrize("external", [False, True])
async def test_mqtt_manager_and_callbacks_persist_pause_resume_without_repeated_start_effects(sessions, external):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.bambu_mqtt import BambuMQTTClient
    from backend.app.services.lifecycle import intake
    from backend.app.services.printer_manager import PrinterManager

    manager = PrinterManager()
    manager.set_print_start_callback(main.on_print_start)
    manager.set_print_running_observed_callback(main.on_print_start)
    manager.set_print_state_change_callback(main.on_print_state_change)
    callbacks = []
    archive_start = AsyncMock()
    identity = "0" if external else "123"
    if not external:
        await add_job(sessions)
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(intake, "printer_manager", manager),
        patch.object(print_effects, "printer_manager", manager),
        patch.object(print_effects, "_archive_print_start", archive_start),
        patch.object(manager, "_schedule_async", side_effect=callbacks.append),
        patch.object(BambuMQTTClient, "connect"),
    ):
        async with sessions() as db:
            await manager.connect_printer(await db.get(Printer, 1))
        client = manager.get_client(1)
        client.state.connected = True
        job_id = None
        for state in ("PAUSE", "PAUSE", "RUNNING", "RUNNING", "PAUSE"):
            client._process_message({"print": {"gcode_state": state, "subtask_id": identity, "gcode_file": "same.3mf"}})
            while callbacks:
                await callbacks.pop(0)
            async with sessions() as db:
                jobs = (await db.scalars(select(PrintQueueItem))).all()
                assert len(jobs) == 1
                job = jobs[0]
                assert job.status == ("paused" if state == "PAUSE" else "printing")
                assert job_id is None or job.id == job_id
                job_id = job.id
        archive_start.assert_awaited_once()

        # Reconnect begins with unknown telemetry; the next matching pause
        # can restore a printing row even though the last known state was PAUSE.
        async with sessions() as db:
            job = await db.get(PrintQueueItem, job_id)
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "paused", "printing")
            await db.commit()
        client.state.connected = False
        client.on_state_change(client.state)
        client.state.connected = True
        client._process_message({"print": {"gcode_state": "PAUSE"}})
        while callbacks:
            await callbacks.pop(0)
        async with sessions() as db:
            assert (await db.get(PrintQueueItem, job_id)).status == "paused"
        archive_start.assert_awaited_once()
