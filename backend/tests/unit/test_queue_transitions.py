"""Exercise the actual status writer and transaction boundaries on a database."""

import logging
import zipfile
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.config import settings
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle.engine import (
    InvalidQueueTransition,
    QueueTransitionConflict,
    transition_queue_item,
)
from backend.app.services.print_scheduler import PrintScheduler


@pytest.fixture
async def sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    with zipfile.ZipFile(tmp_path / "source.3mf", "w") as source_zip:
        source_zip.writestr("Metadata/plate_1.gcode", "G28\nM400\n")
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'queue.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker
    await engine.dispose()


async def make_item(sessions, status="queued", **kwargs):
    async with sessions() as db:
        if status == "queued":
            printer = await db.scalar(select(Printer).limit(1))
            if printer is None:
                printer = Printer(name="Test", serial_number="TEST", ip_address="127.0.0.1", access_code="code")
                db.add(printer)
                await db.flush()
            source_path = settings.base_dir / "source.3mf"
            source = LibraryFile(
                filename="source.3mf", file_path=str(source_path), file_type="3mf", file_size=source_path.stat().st_size
            )
            db.add(source)
            await db.flush()
            kwargs.setdefault("printer_id", printer.id)
            kwargs.setdefault("library_file_id", source.id)
        item = PrintQueueItem(status=status, **kwargs)
        db.add(item)
        await db.commit()
        return item.id


@pytest.mark.parametrize(
    "path",
    [
        ("queued", "dispatching", "printing", "finished", "successful"),
        ("queued", "preheating", "dispatching", "printing", "paused", "printing", "failed", "unsuccessful"),
        ("queued", "unsuccessful"),
        ("queued", "preheating", "cancelled", "unsuccessful"),
        ("dispatching", "failed", "unsuccessful"),
    ],
)
async def test_existing_workflows_keep_their_status_paths(sessions, path):
    item_id = await make_item(sessions, path[0])
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        for before, after in zip(path, path[1:], strict=False):
            await transition_queue_item(
                db,
                item,
                before,
                after,
                action="cancel"
                if before == "queued" and after == "unsuccessful"
                else "clear_plate"
                if before in ("finished", "failed", "cancelled")
                else None,
            )
            await db.commit()
            assert item.status == after
            await db.refresh(item)
            assert item.status == after


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("completed", "queued"),
        ("cancelled", "printing"),
        ("queued", "printing"),
        ("printing", "queued"),
        ("queued", "printing"),
        ("unknown", "unknown"),
    ],
)
async def test_invalid_edges_leave_database_unchanged(sessions, before, after):
    item_id = await make_item(sessions, before)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(InvalidQueueTransition):
            await transition_queue_item(
                db,
                item,
                before,
                after,
                action="cancel"
                if before == "queued" and after == "unsuccessful"
                else "clear_plate"
                if before in ("finished", "failed", "cancelled")
                else None,
            )
        await db.commit()
        await db.refresh(item)
        assert item.status == before


async def test_cancellation_wins_against_stale_dispatch_and_its_metadata(sessions):
    item_id = await make_item(sessions)
    async with sessions() as worker, sessions() as user:
        stale = await worker.get(PrintQueueItem, item_id)
        await worker.commit()  # Retain the stale ORM snapshot, release the read transaction.
        current = await user.get(PrintQueueItem, item_id)
        await transition_queue_item(
            user, current, "queued", "unsuccessful", action="cancel", values={"error_message": "Cancelled"}
        )
        await user.commit()
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(
                worker,
                stale,
                "queued",
                "dispatching",
                values={"dispatch_subtask_id": "123"},
            )
        await worker.rollback()
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.error_message, item.dispatch_subtask_id) == ("unsuccessful", "Cancelled", None)


async def test_deleted_item_cannot_be_transitioned(sessions):
    item_id = await make_item(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        await db.delete(item)
        await db.commit()
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(db, item, "queued", "dispatching")


async def test_replaced_dispatch_claim_is_rejected_even_while_pending(sessions):
    now = datetime.now()
    item_id = await make_item(sessions, dispatching_at=now)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(
                db,
                item,
                "queued",
                "dispatching",
                conditions=(PrintQueueItem.dispatching_at == now - timedelta(seconds=1),),
                values={"dispatch_subtask_id": "123"},
            )
        await db.rollback()
        await db.refresh(item)
        assert item.status == "queued"
        assert item.dispatch_subtask_id is None


async def test_status_and_metadata_share_callers_transaction(sessions):
    item_id = await make_item(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        await transition_queue_item(
            db,
            item,
            "queued",
            "dispatching",
            values={"error_message": "Upload failed"},
        )
        item.completed_at = datetime.now()
        await db.flush()
        # Writer must not have committed independently.
        await db.rollback()
        await db.refresh(item)
        assert (item.status, item.error_message, item.completed_at) == ("queued", None, None)


async def test_transition_log_records_only_committed_edges(sessions, caplog):
    item_id = await make_item(sessions)
    with caplog.at_level(logging.INFO, logger="backend.app.services.lifecycle.engine"):
        async with sessions() as db:
            item = await db.get(PrintQueueItem, item_id)
            await transition_queue_item(db, item, "queued", "dispatching")
            assert f"Queue job {item_id}: queued -> dispatching" not in caplog.text
            await db.rollback()
            item = await db.get(PrintQueueItem, item_id)
            await transition_queue_item(db, item, "queued", "dispatching")
            await db.commit()
    assert caplog.text.count(f"Queue job {item_id}: queued -> dispatching") == 1


async def test_flush_does_not_emit_an_unconditional_status_write(sessions):
    item_id = await make_item(sessions)
    statements = []
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        engine = db.bind.sync_engine

        def capture(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith("UPDATE print_queue"):
                statements.append(statement)

        event.listen(engine, "before_cursor_execute", capture)
        try:
            await transition_queue_item(db, item, "queued", "dispatching")
            item.error_message = "Upload failed"
            await db.commit()
        finally:
            event.remove(engine, "before_cursor_execute", capture)
    status_writes = [statement for statement in statements if "status=" in statement.split(" WHERE ")[0]]
    assert len(status_writes) == 1
    assert "print_queue.status =" in status_writes[0].split(" WHERE ")[1]
    assert len(statements) == 2  # Conditional status, then metadata only.


@pytest.mark.parametrize("detached", [False, True])
async def test_direct_status_write_is_rejected_without_calling_helper(sessions, detached):
    item_id = await make_item(sessions)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        if detached:
            db.expunge(item)
        with pytest.raises(InvalidQueueTransition, match="only be changed"):
            item.status = "printing"
        await db.rollback()
        assert await db.scalar(select(PrintQueueItem.status).where(PrintQueueItem.id == item_id)) == "queued"


async def test_late_scheduler_failure_cannot_overwrite_cancel_or_power_off(sessions):
    async with sessions() as db:
        printer = Printer(name="Printer", ip_address="127.0.0.1", serial_number="TEST", access_code="code")
        db.add(printer)
        await db.commit()
        printer_id = printer.id
    item_id = await make_item(sessions, printer_id=printer_id)
    scheduler = PrintScheduler()
    async with sessions() as worker, sessions() as user:
        stale = await worker.get(PrintQueueItem, item_id)
        await worker.commit()
        current = await user.get(PrintQueueItem, item_id)
        await transition_queue_item(user, current, "queued", "unsuccessful", action="cancel")
        await user.commit()
        with (
            patch("backend.app.services.print_scheduler.printer_manager.is_connected", return_value=False),
            pytest.raises(QueueTransitionConflict),
        ):
            await scheduler._start_print(worker, stale)
        await worker.rollback()
    async with sessions() as db:
        assert await db.scalar(select(PrintQueueItem.status).where(PrintQueueItem.id == item_id)) == "unsuccessful"


async def test_stop_winning_confirmation_race_does_not_publish_job_started(sessions):
    from contextlib import asynccontextmanager

    item_id = await make_item(sessions, "dispatching")
    scheduler = PrintScheduler()
    publish = AsyncMock()

    @asynccontextmanager
    async def racing_session():
        async with sessions() as db:
            original_get = db.get

            async def read_then_stop(*args, **kwargs):
                item = await original_get(*args, **kwargs)
                await db.commit()
                async with sessions() as user:
                    current = await user.get(PrintQueueItem, item_id)
                    await transition_queue_item(user, current, "dispatching", "cancelled")
                    await user.commit()
                return item

            with patch.object(db, "get", read_then_stop):
                yield db

    with (
        patch("backend.app.core.database.async_session", racing_session),
        patch.object(scheduler, "_wait_for_print_start_ack", AsyncMock(return_value=("printing", None))),
        patch.object(scheduler, "_publish_queue_job_started", publish),
    ):
        await scheduler._confirm_dispatch(queue_item_id=item_id, printer_id=1, dispatch_subtask_id="123")
    publish.assert_not_awaited()
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.status == "cancelled"
        assert item.started_at is None


async def test_conflict_does_not_autoflush_dirty_metadata(sessions):
    item_id = await make_item(sessions)
    statements = []
    async with sessions() as worker, sessions() as user:
        stale = await worker.get(PrintQueueItem, item_id)
        await worker.commit()
        current = await user.get(PrintQueueItem, item_id)
        await transition_queue_item(
            user, current, "queued", "unsuccessful", action="cancel", values={"error_message": "Stopped by user"}
        )
        await user.commit()
        stale.error_message = "Stale upload failure"

        def capture(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith("UPDATE print_queue"):
                statements.append(statement)

        engine = worker.bind.sync_engine
        event.listen(engine, "before_cursor_execute", capture)
        try:
            with pytest.raises(QueueTransitionConflict):
                await transition_queue_item(worker, stale, "queued", "dispatching")
        finally:
            event.remove(engine, "before_cursor_execute", capture)
            await worker.rollback()
        # Even a rolled-back unconditional metadata write would break the
        # helper's no-write-on-conflict contract and could trigger DB effects.
        assert len(statements) == 1
        assert "print_queue.status =" in statements[0].split(" WHERE ")[1]
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.error_message) == ("unsuccessful", "Stopped by user")


async def test_drying_reservation_release_cannot_overwrite_cancellation(sessions):
    item_id = await make_item(sessions, "dispatching", wait_for_drying_complete=True)
    async with sessions() as worker, sessions() as user:
        stale = await worker.get(PrintQueueItem, item_id)
        await worker.commit()
        current = await user.get(PrintQueueItem, item_id)
        await transition_queue_item(user, current, "dispatching", "cancelled")
        await user.commit()
        with pytest.raises(QueueTransitionConflict):
            await PrintScheduler()._prepare_drying_for_dispatch(
                worker, stale, 1, active_ams_ids=(0,), release_dispatch_reservation=True
            )
        await worker.rollback()
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert (item.status, item.waiting_reason) == ("cancelled", None)


def _cancel_after_first_select(sessions, db, item_id, *, marker=None):
    """Wrap ``db.execute`` so another session cancels ``item_id`` right after a read.

    The read's rows are already loaded, so the caller acts on a stale status.
    """
    original_execute = db.execute
    raced = []

    async def execute_then_cancel(statement, *args, **kwargs):
        result = await original_execute(statement, *args, **kwargs)
        if not raced and (marker is None or marker in str(statement)):
            raced.append(True)
            async with sessions() as user:
                current = await user.get(PrintQueueItem, item_id)
                await transition_queue_item(user, current, current.status, "cancelled")
                await user.commit()
        return result

    return patch.object(db, "execute", execute_then_cancel)


async def test_restart_recovery_skips_an_item_changed_mid_pass(sessions):
    from types import SimpleNamespace

    raced = await make_item(sessions, "dispatching", printer_id=1, dispatch_subtask_id="111")
    other = await make_item(sessions, "dispatching", printer_id=2, dispatch_subtask_id="222")
    telemetry = {
        1: SimpleNamespace(connected=True, state="RUNNING", subtask_id="111"),
        2: SimpleNamespace(connected=True, state="RUNNING", subtask_id="222"),
    }
    scheduler = PrintScheduler()
    async with sessions() as db:
        with (
            _cancel_after_first_select(sessions, db, raced),
            patch("backend.app.services.print_scheduler.printer_manager.get_status", telemetry.get),
            patch("backend.app.services.print_scheduler.spawn_background_task", lambda coro, **_: coro.close()),
        ):
            await scheduler._recover_stale_dispatches(db)

    async with sessions() as db:
        statuses = {item.id: item.status for item in (await db.scalars(select(PrintQueueItem))).all()}
    assert statuses == {raced: "cancelled", other: "printing"}


async def test_heat_soak_dispatch_that_loses_a_race_still_turns_heaters_off(sessions):
    async with sessions() as db:
        printer = Printer(name="Printer", ip_address="127.0.0.1", serial_number="SOAK", access_code="code")
        db.add(printer)
        await db.commit()
        printer_id = printer.id
    scheduler = PrintScheduler()
    item_id = await make_item(
        sessions,
        "dispatching",
        printer_id=printer_id,
        chamber_heat_soak=True,
        preheat_owner=scheduler._heat_soak.owner,
    )

    async def start_print_after_user_cancel(db, item, *, heat_soak_complete):
        async with sessions() as user:
            current = await user.get(PrintQueueItem, item.id)
            await transition_queue_item(user, current, "dispatching", "cancelled")
            await user.commit()
        # The worker's copy still says dispatching, so the real writer conflicts.
        await scheduler._fail_queue_item(db, item, "Printer not connected")

    heat_soak_printers = MagicMock()
    heat_soak_printers.get_client.return_value = None
    heat_soak_printers.get_status.return_value = None
    with (
        patch("backend.app.services.print_scheduler.async_session", sessions),
        patch("backend.app.services.chamber_heat_soak.printer_manager", heat_soak_printers),
        patch.object(scheduler, "_start_print", start_print_after_user_cancel),
    ):
        await scheduler._dispatch_after_heat_soak(item_id)

    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        printer = await db.get(Printer, printer_id)
        assert (item.status, item.manual_start, item.preheat_owner) == ("cancelled", False, None)
        assert printer.heat_soak_shutdown_pending
