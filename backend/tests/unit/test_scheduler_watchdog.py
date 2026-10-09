"""Regression tests for durable queue dispatch acknowledgement."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.lifecycle import effects as lifecycle_effects
from backend.app.services.lifecycle.engine import transition_queue_item
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.queue_archive import link_dispatch_archive, prepare_dispatch_archive


@pytest.fixture
async def db_session(tmp_path, monkeypatch):
    """In-memory SQLite with one queue item assigned to printer 42."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import backend.app.models  # noqa: F401 - populate Base.metadata
    from backend.app.core.config import settings
    from backend.app.core.database import Base, _migrate_queue_lifecycle
    from backend.app.models.archive import PrintArchive
    from backend.app.models.printer import Printer

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    source = tmp_path / "source.3mf"
    source.write_bytes(b"dispatch source")

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate_queue_lifecycle(conn)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        db.add(Printer(id=42, name="Test", serial_number="TEST", ip_address="127.0.0.1", access_code="code"))
        db.add(PrintArchive(id=99, filename="source.3mf", file_path=str(source), file_size=15, status="completed"))
        db.add(PrintQueueItem(id=1, printer_id=42, archive_id=99, status="queued"))
        await db.commit()

    try:
        yield session_maker
    finally:
        await engine.dispose()


async def hold_and_link(db, item):
    await transition_queue_item(db, item, item.status, "dispatching")
    await db.commit()
    prepared = await prepare_dispatch_archive(db, item)
    await link_dispatch_archive(db, item, prepared)


def _status(state: str, subtask_id: str | None = None, gcode_file: str | None = None):
    return SimpleNamespace(connected=True, state=state, subtask_id=subtask_id, gcode_file=gcode_file)


class TestDurableDispatchingState:
    @pytest.mark.asyncio
    async def test_restart_recovery_publishes_the_normal_start_event(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
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
                    "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                    return_value=_status("RUNNING", "12345"),
                ),
                patch("backend.app.services.lifecycle.dispatching.spawn_background_task", side_effect=spawn),
                patch.object(lifecycle_effects, "publish_queue_job_started", new=publish),
            ):
                await scheduler.dispatcher.recover(db)
                await asyncio.gather(*tasks)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "printing"
            assert item.started_at is not None
        publish.assert_awaited_once_with(1)

    @pytest.mark.asyncio
    async def test_restart_recovery_publishes_no_start_when_its_commit_fails(self, db_session):
        """A recovered start is published only once the promotion has committed."""
        from sqlalchemy import event
        from sqlalchemy.exc import OperationalError

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            scheduler = PrintScheduler()
            publish, spawn = AsyncMock(), MagicMock()

            def fail_commit(_connection):
                raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

            engine = db.bind.sync_engine
            event.listen(engine, "commit", fail_commit)
            try:
                with (
                    patch(
                        "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                        return_value=_status("RUNNING", "12345"),
                    ),
                    patch("backend.app.services.lifecycle.dispatching.spawn_background_task", spawn),
                    patch.object(lifecycle_effects, "publish_queue_job_started", new=publish),
                    pytest.raises(OperationalError),
                ):
                    await scheduler.dispatcher.recover(db)
            finally:
                event.remove(engine, "commit", fail_commit)
            await db.rollback()

        spawn.assert_not_called()
        publish.assert_not_called()
        async with db_session() as db:
            assert (await db.get(PrintQueueItem, 1)).status == "dispatching"

    @pytest.mark.asyncio
    async def test_restart_recovery_does_not_promote_an_active_print_with_another_submission_id(self, db_session):
        """An unrelated manual print must not acknowledge a durable dispatch."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            with patch(
                "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                return_value=_status("RUNNING", "other-job"),
            ):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.started_at is None

    @pytest.mark.asyncio
    async def test_restart_recovery_does_not_treat_missing_ids_as_a_match(self, db_session):
        """Legacy rows without an id must not accept an uncorrelated active print."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = None
            await db.commit()

            with patch(
                "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                return_value=_status("RUNNING"),
            ):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.started_at is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("printer_state", "expected_status"),
        [("FINISH", "finished"), ("FAILED", "failed")],
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
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            complete = AsyncMock()
            status = _status(printer_state, "12345", "completed-while-down.3mf")
            status.raw_data = {"subtask_id": "12345"}
            tasks: list[asyncio.Task] = []

            def spawn(coro, **_kwargs):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

            with (
                patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", return_value=status),
                patch("backend.app.services.lifecycle.intake.print_completed", new=complete),
                patch("backend.app.services.lifecycle.dispatching.spawn_background_task", side_effect=spawn),
            ):
                await PrintScheduler().dispatcher.recover(db)
                await asyncio.gather(*tasks)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == expected_status
            assert item.completed_at is not None
            complete.assert_awaited_once_with(
                42,
                {
                    "status": "completed" if expected_status == "finished" else expected_status,
                    "filename": "completed-while-down.3mf",
                    "subtask_name": "",
                    "subtask_id": "12345",
                    "raw_data": {"subtask_id": "12345"},
                    "_reconciled": True,
                    "_recovered_dispatch": True,
                },
            )


class TestActivePrinterReservation:
    @pytest.mark.asyncio
    async def test_database_allows_only_one_active_queue_item_per_printer(self, db_session):
        async with db_session() as db:
            first = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, first)
            await db.commit()

            db.add(PrintQueueItem(id=2, printer_id=42, archive_id=100, status="dispatching"))
            with pytest.raises(IntegrityError):
                await db.commit()
            await db.rollback()
