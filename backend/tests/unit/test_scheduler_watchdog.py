"""Regression tests for durable queue dispatch acknowledgement."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.print_scheduler import PrintScheduler


@pytest.fixture
async def db_session():
    """In-memory SQLite with one queue item assigned to printer 42."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import backend.app.models  # noqa: F401 - populate Base.metadata
    from backend.app.core.database import Base, _ensure_active_queue_printer_reservation

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_active_queue_printer_reservation(conn)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        db.add(PrintQueueItem(id=1, printer_id=42, archive_id=99, status="pending"))
        await db.commit()

    try:
        yield session_maker
    finally:
        await engine.dispose()


def _status(state: str, subtask_id: str | None = None, gcode_file: str | None = None):
    return SimpleNamespace(state=state, subtask_id=subtask_id, gcode_file=gcode_file)


class TestDurableDispatchingState:
    @pytest.mark.asyncio
    async def test_confirmation_promotes_only_after_active_telemetry(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "dispatching"
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        scheduler = PrintScheduler()
        publish = AsyncMock()
        with (
            patch.object(
                scheduler,
                "_wait_for_print_start_ack",
                new=AsyncMock(return_value=(True, False, _status("PREPARE"))),
            ),
            patch("backend.app.services.print_scheduler.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
            patch.object(scheduler, "_publish_queue_job_started", new=publish),
        ):
            await scheduler._confirm_dispatch(
                queue_item_id=1,
                printer_id=42,
                remote_filename="test.3mf",
                pre_state="IDLE",
                pre_subtask_id="OLD_SUBTASK",
                pre_gcode_file="/old.3mf",
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            assert item.status == "printing"
            assert item.started_at is not None
        publish.assert_awaited_once_with(1)

    @pytest.mark.asyncio
    async def test_unacknowledged_dispatch_returns_to_pending_and_reconnects(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "dispatching"
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        scheduler = PrintScheduler()
        client = MagicMock()
        with (
            patch.object(
                scheduler,
                "_wait_for_print_start_ack",
                new=AsyncMock(return_value=(False, False, _status("IDLE", "OLD_SUBTASK", "/old.3mf"))),
            ),
            patch("backend.app.services.print_scheduler.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
            patch("backend.app.services.print_scheduler.printer_manager.get_client", return_value=client),
        ):
            await scheduler._confirm_dispatch(
                queue_item_id=1,
                printer_id=42,
                remote_filename="test.3mf",
                pre_state="IDLE",
                pre_subtask_id="OLD_SUBTASK",
                pre_gcode_file="/old.3mf",
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            assert item.status == "pending"
            assert item.dispatched_at is None
            assert item.started_at is None
        client.force_reconnect_stale_session.assert_called_once()

    @pytest.mark.asyncio
    async def test_unacknowledged_dispatch_unregisters_its_expected_print(self, db_session):
        from backend.app.main import _expected_prints, register_expected_print, unregister_expected_print

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "dispatching"
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        register_expected_print(42, "test.3mf", archive_id=99)
        scheduler = PrintScheduler()
        with (
            patch.object(
                scheduler,
                "_wait_for_print_start_ack",
                new=AsyncMock(return_value=(False, False, _status("IDLE", "OLD_SUBTASK", "/old.3mf"))),
            ),
            patch("backend.app.services.print_scheduler.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
            patch("backend.app.services.print_scheduler.printer_manager.get_client", return_value=None),
        ):
            await scheduler._confirm_dispatch(
                queue_item_id=1,
                printer_id=42,
                remote_filename="test.3mf",
                pre_state="IDLE",
                pre_subtask_id="OLD_SUBTASK",
                pre_gcode_file="/old.3mf",
            )

        assert not any(key[0] == 42 for key in _expected_prints)
        unregister_expected_print(42)

    @pytest.mark.asyncio
    async def test_confirmation_does_not_requeue_a_terminal_dispatch(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "failed"
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        scheduler = PrintScheduler()
        with (
            patch.object(
                scheduler,
                "_wait_for_print_start_ack",
                new=AsyncMock(return_value=(False, False, _status("FAILED"))),
            ),
            patch("backend.app.services.print_scheduler.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
        ):
            await scheduler._confirm_dispatch(
                queue_item_id=1,
                printer_id=42,
                remote_filename="test.3mf",
                pre_state="IDLE",
                pre_subtask_id=None,
                pre_gcode_file=None,
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            assert item.status == "failed"

    @pytest.mark.asyncio
    async def test_restart_recovery_publishes_the_normal_start_event(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "dispatching"
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

            scheduler = PrintScheduler()
            publish = AsyncMock()
            tasks: list[asyncio.Task] = []

            def spawn(coro, **_kwargs):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

            with (
                patch(
                    "backend.app.services.print_scheduler.printer_manager.get_status", return_value=_status("RUNNING")
                ),
                patch("backend.app.services.print_scheduler.spawn_background_task", side_effect=spawn),
                patch.object(scheduler, "_publish_queue_job_started", new=publish),
            ):
                await scheduler._recover_stale_dispatches(db)
                await asyncio.gather(*tasks)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "printing"
            assert item.started_at is not None
        publish.assert_awaited_once_with(1)

    @pytest.mark.asyncio
    async def test_restart_recovery_requeues_stale_dispatch(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "dispatching"
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            await db.commit()

            with patch("backend.app.services.print_scheduler.printer_manager.get_status", return_value=_status("IDLE")):
                await PrintScheduler()._recover_stale_dispatches(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "pending"
            assert item.dispatched_at is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("printer_state", "expected_status"),
        [("FINISH", "completed"), ("FAILED", "failed")],
    )
    async def test_restart_recovery_completes_matching_terminal_dispatch_instead_of_requeueing(
        self, db_session, printer_state, expected_status
    ):
        """A job that finished while the service was down must not retry.

        BambuMQTT correctly ignores an arbitrary first terminal update after a
        reconnect. The queue's durable submission id makes this one safe to
        attribute, so recovery passes it through the normal completion handler.
        """
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            item.status = "dispatching"
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            complete = AsyncMock()
            status = _status(printer_state, "12345", "completed-while-down.3mf")
            status.raw_data = {"subtask_id": "0"}
            tasks: list[asyncio.Task] = []

            def spawn(coro, **_kwargs):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

            with (
                patch("backend.app.services.print_scheduler.printer_manager.get_status", return_value=status),
                patch("backend.app.main.on_print_complete", new=complete),
                patch("backend.app.services.print_scheduler.spawn_background_task", side_effect=spawn),
            ):
                await PrintScheduler()._recover_stale_dispatches(db)
                await asyncio.gather(*tasks)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == expected_status
            assert item.completed_at is not None
            complete.assert_awaited_once_with(
                42,
                {
                    "status": expected_status,
                    "filename": "completed-while-down.3mf",
                    "subtask_name": "",
                    "subtask_id": "12345",
                    "raw_data": {"subtask_id": "12345"},
                    "_reconciled": True,
                    "_recovered_dispatch": True,
                },
            )


class TestDispatchConfirmationScheduling:
    @pytest.mark.asyncio
    async def test_slow_confirmation_does_not_block_second_printer_dispatch(self):
        scheduler = PrintScheduler()
        confirmation_started = asyncio.Event()
        release_confirmation = asyncio.Event()
        tasks: list[asyncio.Task] = []
        first = SimpleNamespace(
            id=1,
            printer_id=42,
            archive_id=99,
            library_file_id=None,
            scheduled_time=None,
            manual_start=False,
            force_color_match=None,
            require_previous_success=False,
            ams_mapping="[]",
            filament_overrides=None,
            waiting_reason=None,
            print_time_seconds=None,
            position=0,
            been_jumped=False,
        )
        second = SimpleNamespace(**{**first.__dict__, "id": 2, "printer_id": 43})

        pending_result = MagicMock()
        pending_result.scalars.return_value.all.return_value = [first, second]
        busy_result = MagicMock()
        busy_result.all.return_value = []
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[pending_result, busy_result])

        async def slow_confirmation(**_kwargs):
            confirmation_started.set()
            await release_confirmation.wait()

        dispatched: list[int] = []

        async def start_print(db, item):
            dispatched.append(item.printer_id)
            if item.printer_id == 42:
                scheduler._schedule_dispatch_confirmation(
                    queue_item_id=item.id,
                    printer_id=item.printer_id,
                    remote_filename="first.3mf",
                    pre_state="IDLE",
                    pre_subtask_id=None,
                    pre_gcode_file=None,
                )

        def spawn(coro, **_kwargs):
            task = asyncio.create_task(coro)
            tasks.append(task)
            return task

        with (
            patch.object(scheduler, "_confirm_dispatch", new=slow_confirmation),
            patch("backend.app.services.print_scheduler.spawn_background_task", side_effect=spawn),
            patch("backend.app.services.print_scheduler.async_session") as session_factory,
            patch.object(scheduler, "_recover_stale_dispatches", new=AsyncMock()),
            patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
            patch.object(scheduler, "_is_printer_idle", return_value=True),
            patch("backend.app.services.print_scheduler.printer_manager.is_connected", return_value=True),
            patch.object(scheduler, "_ams_mapping_uses_compatible_materials", return_value=True),
            patch.object(scheduler, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
            patch.object(scheduler, "_start_print", new=start_print),
        ):
            session_factory.return_value.__aenter__ = AsyncMock(return_value=db)
            session_factory.return_value.__aexit__ = AsyncMock(return_value=False)
            await scheduler.check_queue()
            await confirmation_started.wait()
            assert dispatched == [42, 43]
            assert not tasks[0].done()

        release_confirmation.set()
        await asyncio.gather(*tasks)


class TestActivePrinterReservation:
    @pytest.mark.asyncio
    async def test_database_allows_only_one_active_queue_item_per_printer(self, db_session):
        async with db_session() as db:
            first = await db.get(PrintQueueItem, 1)
            first.status = "dispatching"
            await db.commit()

            db.add(PrintQueueItem(id=2, printer_id=42, archive_id=100, status="dispatching"))
            with pytest.raises(IntegrityError):
                await db.commit()
            await db.rollback()

    @pytest.mark.asyncio
    async def test_active_telemetry_is_required_even_after_subtask_advances(self):
        get_status = MagicMock(return_value=_status("FINISH", "NEW_SUBTASK"))
        with patch("backend.app.services.print_scheduler.printer_manager.get_status", get_status):
            acked, landed_on_subtask, _ = await PrintScheduler()._wait_for_print_start_ack(
                printer_id=42,
                pre_state="FINISH",
                pre_subtask_id="OLD_SUBTASK",
                timeout=0.05,
                phase_b_timeout=0.05,
                poll_interval=0.01,
            )

        assert acked is False
        assert landed_on_subtask is True
