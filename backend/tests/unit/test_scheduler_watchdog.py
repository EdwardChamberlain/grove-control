"""Regression tests for durable queue dispatch acknowledgement."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.print_scheduler import PrintScheduler


@pytest.fixture
async def db_session():
    """In-memory SQLite with one queue item assigned to printer 42."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import backend.app.models  # noqa: F401 - populate Base.metadata
    from backend.app.core.database import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
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


class TestDispatchConfirmationScheduling:
    @pytest.mark.asyncio
    async def test_slow_confirmation_does_not_block_the_scheduler(self):
        scheduler = PrintScheduler()
        confirmation_started = asyncio.Event()
        release_confirmation = asyncio.Event()
        tasks: list[asyncio.Task] = []

        async def slow_confirmation(**_kwargs):
            confirmation_started.set()
            await release_confirmation.wait()

        def spawn(coro, **_kwargs):
            task = asyncio.create_task(coro)
            tasks.append(task)
            return task

        with (
            patch.object(scheduler, "_confirm_dispatch", new=slow_confirmation),
            patch("backend.app.services.print_scheduler.spawn_background_task", side_effect=spawn),
        ):
            scheduler._schedule_dispatch_confirmation(
                queue_item_id=1,
                printer_id=42,
                pre_state="IDLE",
                pre_subtask_id=None,
                pre_gcode_file=None,
            )
            await confirmation_started.wait()
            assert not tasks[0].done()

        release_confirmation.set()
        await asyncio.gather(*tasks)

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
