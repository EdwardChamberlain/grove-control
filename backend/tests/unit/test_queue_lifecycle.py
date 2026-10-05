"""Stage 3's physical holds, user actions and one-time upgrade on real SQLite."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.api.routes.print_queue import clear_queue_plate, retry_queue_item
from backend.app.api.routes.printers import clear_plate, delete_printer, get_printer_status
from backend.app.core.database import Base, _migrate_queue_lifecycle
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.lifecycle.awaiting import clear_job_plate
from backend.app.services.lifecycle.engine import (
    ACTIVE_STATUSES,
    AWAITING_PLATE_CLEAR_STATUSES,
    HOLDING_STATUSES,
    InvalidQueueTransition,
    transition_queue_item,
)
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.queue_actions import cancel_job


@pytest.fixture
async def sessions(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'lifecycle.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(Printer(id=1, name="Printer", serial_number="TEST", ip_address="127.0.0.1", access_code="code"))
        await db.commit()
    yield maker
    await engine.dispose()


@pytest.mark.parametrize("status", HOLDING_STATUSES)
async def test_every_holding_state_blocks_a_second_job_even_with_confirmation_off(sessions, status):
    async with sessions() as db:
        db.add_all([Settings(key="require_plate_clear", value="false"), PrintQueueItem(printer_id=1, status=status)])
        await db.commit()
        db.add(PrintQueueItem(printer_id=1, status="queued"))
        await db.commit()  # Targeting the printer does not hold it.
        db.add(PrintQueueItem(printer_id=1, status="dispatching"))
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()


@pytest.mark.parametrize("status", ("finished", "failed", "cancelled"))
@pytest.mark.parametrize("confirmation", ("true", "false"))
async def test_only_successful_physical_completion_clears_automatically(sessions, status, confirmation):
    async with sessions() as db:
        db.add(Settings(key="require_plate_clear", value=confirmation))
        item = PrintQueueItem(printer_id=1, status="printing")
        db.add(item)
        await db.commit()
        await transition_queue_item(db, item, "printing", status)
        await db.commit()
        assert item.status == ("successful" if status == "finished" and confirmation == "false" else status)
        if item.status in AWAITING_PLATE_CLEAR_STATUSES:
            await clear_job_plate(db, item)
            await db.commit()
        assert item.status == ("successful" if status == "finished" else "unsuccessful")


@pytest.mark.parametrize("status", ("queued", *ACTIVE_STATUSES))
async def test_cancel_chooses_destination_and_retains_active_holds(sessions, status):
    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status=status)
        db.add(item)
        await db.commit()
        with patch("backend.app.services.printer_manager.printer_manager.stop_print") as stop:
            await cancel_job(db, item)
        assert item.status == ("unsuccessful" if status == "queued" else "cancelled")
        assert stop.called == (status != "queued")
        if status != "queued":
            db.add(PrintQueueItem(printer_id=1, status="dispatching"))
            with pytest.raises(IntegrityError):
                await db.commit()
            await db.rollback()


async def test_stop_succeeds_when_auto_off_cannot_be_scheduled(sessions):
    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status="printing", auto_off_after=True)
        db.add(item)
        await db.commit()
        attempted = asyncio.Event()

        async def fail_plug(*_args, **_kwargs):
            attempted.set()
            raise RuntimeError("plug unreachable")

        failing_plug = AsyncMock(side_effect=fail_plug)
        with (
            patch("backend.app.services.printer_manager.printer_manager.stop_print") as stop,
            patch(
                "backend.app.services.smart_plug_manager.smart_plug_manager.schedule_off_after_queue_job",
                failing_plug,
            ),
        ):
            await cancel_job(db, item)  # Does not raise after the committed stop.
            await asyncio.wait_for(attempted.wait(), 2)
        failing_plug.assert_awaited_once()
        stop.assert_called_once_with(1)
        await db.refresh(item)
        assert item.status == "cancelled"


@pytest.mark.parametrize("status", ("queued", *ACTIVE_STATUSES))
async def test_system_cannot_release_waiting_or_active_jobs(sessions, status):
    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status=status)
        db.add(item)
        await db.commit()
        with pytest.raises(InvalidQueueTransition):
            await transition_queue_item(db, item, status, "unsuccessful")
        if status != "queued":
            with pytest.raises(InvalidQueueTransition):
                await transition_queue_item(db, item, status, "queued")


async def test_plate_view_updates_after_commit_and_not_on_rollback_or_queued_cancel(sessions):
    manager = PrinterManager()
    with patch("backend.app.services.printer_manager.printer_manager", manager):
        async with sessions() as db:
            item = PrintQueueItem(printer_id=1, status="printing")
            queued = PrintQueueItem(printer_id=1, status="queued")
            db.add_all([item, queued])
            await db.commit()
            await transition_queue_item(db, item, "printing", "failed")
            assert not manager.is_awaiting_plate_clear(1)
            await db.rollback()
            assert not manager.is_awaiting_plate_clear(1)
            await db.refresh(item)
            await transition_queue_item(db, item, "printing", "failed")
            await db.commit()
            assert manager.is_awaiting_plate_clear(1)
            await db.refresh(queued)
            await cancel_job(db, queued)
            assert manager.is_awaiting_plate_clear(1)


@pytest.mark.parametrize("route", ("queue", "printer"))
async def test_clear_plate_works_offline_and_final_jobs_leave_the_live_queue(sessions, route):
    from backend.app.api.routes.print_queue import list_queue

    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status="failed")
        db.add(item)
        await db.commit()
        with patch("backend.app.api.routes.printers.printer_manager.get_status", return_value=None):
            status = await get_printer_status(1, db=db, _=None)
        assert status.awaiting_plate_clear
        if route == "queue":
            await clear_queue_plate(item.id, db=db, _=None)
        else:
            await clear_plate(1, db=db, _=None)
        assert item.status == "unsuccessful"
        response = await list_queue(db=db, auth_result=(None, True), printer_id=None, status=None, target_model=None)
        assert response == []


@pytest.mark.parametrize("route", ("queue", "printer"))
@pytest.mark.parametrize("active", ("PREPARE", "SLICING", "RUNNING", "PAUSE"))
async def test_clear_plate_cannot_release_an_older_hold_while_another_print_is_active(sessions, route, active):
    from fastapi import HTTPException

    live = SimpleNamespace(connected=True, job_telemetry_ready=True, state=active, submission_id="new-print")
    async with sessions() as db:
        old = PrintQueueItem(printer_id=1, status="finished", dispatch_subtask_id="old")
        db.add(old)
        await db.commit()
        with (
            patch("backend.app.services.printer_manager.printer_manager.get_status", return_value=live),
            pytest.raises(HTTPException) as conflict,
        ):
            if route == "queue":
                await clear_queue_plate(old.id, db=db, _=None)
            else:
                await clear_plate(1, db=db, _=None)
        assert conflict.value.status_code == 409
        await db.rollback()
        await db.refresh(old)
        assert old.status == "finished"


async def test_auto_clear_keeps_the_outcome_and_hold_if_another_print_is_already_active(sessions):
    live = SimpleNamespace(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="new-print")
    async with sessions() as db:
        old = PrintQueueItem(printer_id=1, status="printing", dispatch_subtask_id="old")
        db.add_all([old, Settings(key="require_plate_clear", value="false")])
        await db.commit()
        with patch("backend.app.services.printer_manager.printer_manager.get_status", return_value=live):
            await transition_queue_item(db, old, "printing", "finished")
            await db.commit()
        assert old.status == "finished"


async def test_retry_is_a_new_job_at_top_and_keeps_original_hold_and_settings(sessions, tmp_path):
    source = tmp_path / "source.3mf"
    source.write_bytes(b"source")
    async with sessions() as db:
        library = LibraryFile(filename="source.3mf", file_path=str(source), file_size=6, file_type="3mf")
        db.add(library)
        await db.flush()
        old = PrintQueueItem(
            printer_id=1,
            target_model="H2D",
            library_file_id=library.id,
            status="failed",
            plate_id=2,
            ams_mapping="[1, 2]",
            chamber_heat_soak=True,
            nozzle_mapping="[3, 4]",
        )
        db.add_all([old, PrintQueueItem(target_model="H2D", status="queued", position=-17)])
        await db.commit()
        result = await retry_queue_item(old.id, db=db, auth_result=(None, True), _=None)
        new = await db.get(PrintQueueItem, result.id)
        assert new.id != old.id and new.status == "queued" and new.position < -17
        assert old.status == "failed"
        assert new.printer_id is None and new.target_model == "H2D"
        assert new.library_file_id == library.id and new.archive_id is None
        # The tray mapping bound to the old printer at dispatch is chosen again
        # with the printer, like any other "Any machine" job.
        assert (new.plate_id, new.ams_mapping, new.nozzle_mapping, new.chamber_heat_soak) == (
            2,
            None,
            "[3, 4]",
            True,
        )
        assert new.dispatch_subtask_id is None and new.started_at is None


async def test_retry_uses_archive_copy_when_source_has_gone(sessions, tmp_path):
    copy = tmp_path / "sent.3mf"
    copy.write_bytes(b"sent")
    async with sessions() as db:
        archive = PrintArchive(printer_id=1, filename="sent.3mf", file_path=str(copy), file_size=4, status="failed")
        db.add(archive)
        await db.flush()
        old = PrintQueueItem(printer_id=1, archive_id=archive.id, status="failed")
        missing = LibraryFile(filename="gone.3mf", file_path=str(tmp_path / "gone.3mf"), file_size=4, file_type="3mf")
        db.add(missing)
        await db.flush()
        old.variants = [PrintQueueVariant(library_file_id=missing.id, target_model="H2S", position=0)]
        db.add(old)
        await db.commit()
        result = await retry_queue_item(old.id, db=db, auth_result=(None, True), _=None)
        assert result.archive_id == archive.id and result.library_file_id is None
        assert result.variants == []
        assert old.status == "failed"


@pytest.mark.parametrize("status", HOLDING_STATUSES)
async def test_deleting_printer_ends_holding_job_and_leaves_waiting_job_to_retarget(sessions, status):
    async with sessions() as db:
        old = PrintQueueItem(printer_id=1, status=status)
        waiting = PrintQueueItem(printer_id=1, status="queued")
        db.add_all([old, waiting])
        await db.commit()
        with patch("backend.app.api.routes.printers.printer_manager.disconnect_printer"):
            await delete_printer(1, delete_archives=False, db=db, _=None)
        await db.refresh(old)
        await db.refresh(waiting)
        assert old.status == ("successful" if status == "finished" else "unsuccessful")
        # A finished print stays a success; only an unsuccessful end is explained.
        assert old.error_message == (None if status == "finished" else "Printer deleted")
        assert old.printer_id is None and old.completed_at is not None
        assert waiting.status == "queued" and waiting.printer_id is None


@pytest.mark.parametrize("state", ["preheating", "soak-dispatching", "shutdown-pending"])
@pytest.mark.parametrize("connected", [True, False])
async def test_deleting_printer_waits_for_heat_soak_shutdown_while_reachable(sessions, state, connected):
    from fastapi import HTTPException

    async with sessions() as db:
        printer = await db.get(Printer, 1)
        if state == "shutdown-pending":
            printer.heat_soak_shutdown_pending = True
        else:
            db.add(
                PrintQueueItem(
                    printer_id=1,
                    status="preheating" if state == "preheating" else "dispatching",
                    chamber_heat_soak=True,
                )
            )
        await db.commit()
        with (
            patch("backend.app.api.routes.printers.printer_manager.is_connected", return_value=connected),
            patch("backend.app.api.routes.printers.printer_manager.disconnect_printer") as disconnect,
        ):
            if connected:
                # Heaters may be on and only this printer row can retry their
                # shutdown until telemetry confirms it: stop and wait first.
                with pytest.raises(HTTPException) as refused:
                    await delete_printer(1, delete_archives=False, db=db, _=None)
                assert refused.value.status_code == 409
                disconnect.assert_not_called()
            else:
                # Grove cannot command an unreachable printer, so it is not held.
                await delete_printer(1, delete_archives=False, db=db, _=None)
                disconnect.assert_called_once_with(1)
        await db.rollback()
    async with sessions() as db:
        assert (await db.get(Printer, 1) is not None) == connected


async def test_migration_preserves_exact_hold_creates_missing_job_and_runs_once(sessions):
    engine = sessions.kw["bind"]
    async with engine.begin() as conn:
        await conn.execute(text("DROP INDEX uq_print_queue_holding_printer"))
    async with sessions() as db:
        printer = await db.get(Printer, 1)
        printer.awaiting_plate_clear = True
        db.add(
            Printer(
                id=2,
                name="Other",
                serial_number="OTHER",
                ip_address="127.0.0.2",
                access_code="code",
                awaiting_plate_clear=True,
            )
        )
        archive = PrintArchive(printer_id=1, filename="old.3mf", file_path="old.3mf", file_size=1, status="failed")
        db.add(archive)
        await db.flush()
        held = PrintQueueItem(printer_id=1, archive_id=archive.id, status="failed")
        queued = PrintQueueItem(printer_id=1, status="pending")
        skipped = PrintQueueItem(status="skipped", error_message="Old skip reason")
        history = PrintQueueItem(status="completed")
        db.add_all([held, queued, skipped, history])
        await db.flush()
        archive.dispatched_queue_item_id = held.id
        printer.awaiting_plate_clear_archive_id = archive.id
        await db.commit()
        ids = held.id, queued.id, skipped.id, history.id
    async with engine.begin() as conn:
        await _migrate_queue_lifecycle(conn)
    async with sessions() as db:
        jobs = {item.id: item for item in (await db.scalars(select(PrintQueueItem))).all()}
        assert tuple(jobs[i].status for i in ids) == ("failed", "queued", "queued", "successful")
        assert jobs[ids[2]].error_message is None
        synthetic = next(item for item in jobs.values() if item.printer_id == 2)
        assert synthetic.status == "finished"
        await clear_job_plate(db, jobs[held.id])
        await clear_job_plate(db, synthetic)
        await db.commit()
    async with engine.begin() as conn:
        await _migrate_queue_lifecycle(conn)
        assert await conn.scalar(select(Settings.value).where(Settings.key == "queue_lifecycle_version")) == "3"
    async with sessions() as db:
        jobs = list((await db.scalars(select(PrintQueueItem))).all())
        assert len(jobs) == 5
        assert (await db.get(PrintQueueItem, ids[0])).status == "unsuccessful"
        assert (await db.get(PrintQueueItem, synthetic.id)).status == "successful"


async def test_fresh_and_upgraded_databases_share_one_holding_index_predicate(sessions):
    from backend.app.models.print_queue import HOLDING_INDEX_NAME

    index_sql = text("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = :name")
    engine = sessions.kw["bind"]
    async with engine.connect() as conn:
        fresh = await conn.scalar(index_sql, {"name": HOLDING_INDEX_NAME})  # From the model (create_all).
    async with engine.begin() as conn:
        await _migrate_queue_lifecycle(conn)  # Drops and recreates it on upgrade.
        upgraded = await conn.scalar(index_sql, {"name": HOLDING_INDEX_NAME})
    assert all(f"'{status}'" in fresh for status in HOLDING_STATUSES)
    assert fresh.split(" WHERE ", 1)[1] == upgraded.split(" WHERE ", 1)[1]


async def test_migration_unbinds_waiting_any_machine_jobs_and_keeps_specific_requirements(sessions):
    engine = sessions.kw["bind"]
    async with engine.begin() as conn:
        await conn.execute(text("DROP INDEX uq_print_queue_holding_printer"))
    async with sessions() as db:
        # Older schedulers wrote their pick onto a waiting "Any machine" job.
        stale_pick = PrintQueueItem(printer_id=1, target_model="X1C", status="pending")
        specific = PrintQueueItem(printer_id=1, status="pending")
        db.add_all([stale_pick, specific])
        await db.commit()
        ids = stale_pick.id, specific.id
    async with engine.begin() as conn:
        await _migrate_queue_lifecycle(conn)
    async with sessions() as db:
        stale_pick, specific = [await db.get(PrintQueueItem, i) for i in ids]
        assert (stale_pick.status, stale_pick.printer_id, stale_pick.target_model) == ("queued", None, "X1C")
        assert (specific.status, specific.printer_id) == ("queued", 1)


async def test_heat_soak_does_not_restore_a_stale_printer_assignment(sessions):
    from backend.app.services.lifecycle.preheating import ChamberHeatSoak

    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status="queued", chamber_heat_soak=True)
        db.add(item)
        await db.commit()
        await db.execute(PrintQueueItem.__table__.update().where(PrintQueueItem.id == item.id).values(printer_id=None))
        await db.commit()
        assert item.printer_id == 1  # This worker still has its old snapshot.
        assert not await ChamberHeatSoak().enter(db, item)
        await db.refresh(item)
        assert item.status == "queued" and item.printer_id is None
