"""Dispatch Archive boundaries and source retention on real database sessions."""

import asyncio
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.config import settings
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.archive import ArchiveService
from backend.app.services.lifecycle import dispatching as lifecycle_dispatching
from backend.app.services.lifecycle.awaiting import clear_job_plate
from backend.app.services.lifecycle.engine import QueueTransitionConflict, hold_printer, transition_queue_item, writer
from backend.app.services.queue_actions import cancel_job
from backend.app.services.queue_archive import link_dispatch_archive, prepare_dispatch_archive
from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused
from backend.tests.unit.test_lifecycle_preheating import enter_preheating


@pytest.fixture
async def alignment(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    from backend.app.services.lifecycle import effects as queue_outcome_effects
    from backend.app.services.printer_manager import printer_manager

    # The new database's printers must not inherit another test's cached hold.
    monkeypatch.setattr(printer_manager, "_awaiting_plate_clear", set())
    monkeypatch.setattr(printer_manager, "_awaiting_plate_clear_archive_id", {})
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: None)
    monkeypatch.setattr(printer_manager, "stop_print", lambda _id: True)
    monkeypatch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
    monkeypatch.setattr(printer_manager, "set_awaiting_plate_clear", lambda *_args: None)
    monkeypatch.setattr(printer_manager, "set_awaiting_plate_clear_archive_id", lambda *_args: None)
    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", AsyncMock(return_value=True))
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'jobs.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    source_path = tmp_path / "source.3mf"
    with zipfile.ZipFile(source_path, "w") as source:
        source.writestr("Metadata/plate_1.gcode", ";HEADER_BLOCK_START\nG28\nM400\n; end\n")
    async with sessions() as db:
        printer = Printer(name="Test", serial_number="TEST", ip_address="127.0.0.1", access_code="code", model="X1C")
        source = LibraryFile(
            filename="source.3mf",
            file_path=str(source_path),
            file_type="3mf",
            file_size=source_path.stat().st_size,
            queue_only=True,
        )
        db.add_all([printer, source])
        await db.flush()
        job = PrintQueueItem(assigned_printer_id=printer.id, library_file_id=source.id, status="queued")
        db.add(job)
        await db.commit()
    yield SimpleNamespace(sessions=sessions, job_id=job.id, source_id=source.id, source_path=source_path)
    from backend.app.core.tasks import _background_tasks

    await asyncio.gather(
        *(task for task in tuple(_background_tasks) if task.get_name().startswith("queue-")),
        return_exceptions=True,
    )
    await engine.dispose()


async def hold_and_link(db, job, before="queued"):
    values = {"printer_id": job.assigned_printer_id} if before == "queued" else None
    async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
        await transition_queue_item(db, job, before, "dispatching", values=values)
    await db.commit()
    prepared = await prepare_dispatch_archive(db, job)
    async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
        await link_dispatch_archive(db, job, prepared)
    return prepared


@pytest.mark.parametrize("terminal", ["finished", "failed", "cancelled"])
@pytest.mark.parametrize("clear", [False, True])
async def test_owned_archive_restores_missing_queue_link_before_outcome(alignment, terminal, clear):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "dispatching")
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "printing")
        # An external Archive creation committed, but its Queue link failed.
        attempt = PrintArchive(
            printer_id=job.printer_id,
            dispatched_queue_item_id=job.id,
            filename="same.3mf",
            file_path="",
            file_size=0,
            status="printing",
        )
        db.add(attempt)
        await db.commit()
        assert job.archive_id is None
        if terminal == "cancelled":
            await cancel_job(db, job)
        else:
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "printing", terminal)
            await db.commit()
        if clear:
            await clear_job_plate(db, job)
            await db.commit()
        await db.refresh(attempt)
        assert job.archive_id == attempt.id
        assert attempt.status == {"finished": "completed", "failed": "failed", "cancelled": "aborted"}[terminal]
        assert job.physical_outcome == (None if terminal == "cancelled" else attempt.status)
        assert attempt.dispatched_queue_item_id == job.id


async def test_retry_resets_stop_intent_from_the_previous_attempt(alignment):
    from backend.app.api.routes.print_queue import retry_queue_item

    async with alignment.sessions() as db:
        old = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, old)
        old.ams_mapping = "[2]"
        old.bed_levelling = "false"
        await db.commit()
        await cancel_job(db, old)
        await db.refresh(old)
        requested_at = old.stop_requested_at
        assert requested_at is not None
        result = await retry_queue_item(old.id, db=db, auth_result=(None, True), _=None)
        new = await db.get(PrintQueueItem, result.id)
        assert new.id != old.id and new.status == "queued"
        assert new.stop_requested_at is None
        assert new.dispatch_subtask_id is None and new.dispatched_at is None
        assert new.ams_mapping == "[2]" and new.bed_levelling == "false"
        assert old.stop_requested_at == requested_at


async def test_proven_unsent_failure_creates_one_fresh_top_retry(alignment, monkeypatch):
    from sqlalchemy import func

    from backend.app.services.lifecycle.dispatching import fail

    monkeypatch.setattr(lifecycle_dispatching.effects, "queue_outcome_effect", MagicMock())
    async with alignment.sessions() as db:
        original = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, original)
        await fail(db, original, "Upload failed")

        rows = list((await db.scalars(select(PrintQueueItem).order_by(PrintQueueItem.id))).all())
        parent, retry = rows
        assert parent.status == "failed" and parent.physical_outcome is None
        assert parent.retry_on_failure is True
        assert retry.id != parent.id and retry.status == "queued"
        assert retry.position < parent.position
        assert retry.printer_id is None and retry.assigned_printer_id == parent.assigned_printer_id
        assert retry.retry_on_failure is False
        assert retry.library_file_id == parent.library_file_id

        # A retry-created job has no history link and cannot create a chain.
        async with writer(getattr(retry, "printer_id", None) or getattr(retry, "assigned_printer_id", None)):
            await transition_queue_item(db, retry, "queued", "dispatching")
        await db.commit()
        await fail(db, retry, "Upload failed again")
        assert await db.scalar(select(func.count()).select_from(PrintQueueItem)) == 2
        assert retry.status == "failed" and retry.physical_outcome is None


async def test_unassigned_automatic_retry_drops_printer_specific_ams_mappings(alignment):
    from backend.app.services.lifecycle.queued import create_retry_job

    async with alignment.sessions() as db:
        assigned = await db.get(PrintQueueItem, alignment.job_id)
        original = PrintQueueItem(
            printer_id=assigned.assigned_printer_id,
            library_file_id=alignment.source_id,
            target_model="X1C",
            status="failed",
            ams_mapping="[0]",
            variants=[
                PrintQueueVariant(
                    library_file_id=alignment.source_id,
                    target_model="X1C",
                    position=0,
                    ams_mapping="[0]",
                )
            ],
        )
        db.add(original)
        await db.commit()

        retry = await create_retry_job(db, original)
        await db.commit()
        variants = list(
            (await db.scalars(select(PrintQueueVariant).where(PrintQueueVariant.queue_item_id == retry.id))).all()
        )

        assert retry.status == "queued" and retry.assigned_printer_id is None and retry.printer_id is None
        assert retry.ams_mapping is None
        assert len(variants) == 1 and variants[0].ams_mapping is None


async def test_send_intent_failure_keeps_hold_and_does_not_create_retry(alignment, monkeypatch):
    from sqlalchemy import func

    from backend.app.services.lifecycle.dispatching import fail

    monkeypatch.setattr(lifecycle_dispatching.effects, "queue_outcome_effect", MagicMock())
    async with alignment.sessions() as db:
        item = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, item)
        item.dispatch_subtask_id = "send-intent"
        await db.commit()
        await fail(db, item, "Send result is ambiguous")
        await db.refresh(item)
        assert item.status == "failed" and item.physical_outcome == "failed"
        assert await db.scalar(select(func.count()).select_from(PrintQueueItem)) == 1


@pytest.mark.parametrize("before", ["queued", "preheating"])
async def test_hold_commits_before_archive_link_and_same_state_never_copies_again(alignment, before):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if before == "preheating":
            await enter_preheating(db, job)
            assert await db.scalar(select(PrintArchive.id)) is None
        values = {"printer_id": job.assigned_printer_id} if before == "queued" else None
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, before, "dispatching", values=values)
        await db.commit()
        async with alignment.sessions() as observer:
            assert (await observer.get(PrintQueueItem, job.id)).status == "dispatching"
            assert await observer.scalar(select(PrintArchive.id)) is None
        prepared = await prepare_dispatch_archive(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await link_dispatch_archive(db, job, prepared)
        attempt = await db.get(PrintArchive, job.archive_id)
        copied = settings.base_dir / attempt.file_path
        assert copied.read_bytes() == alignment.source_path.read_bytes()
        assert attempt.dispatched_queue_item_id == job.id and attempt.status == "dispatching"
        async with alignment.sessions() as observer:
            assert (await observer.get(PrintQueueItem, job.id)).status == "dispatching"
            assert await observer.scalar(select(PrintArchive.id)) is None
        await db.commit()
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "dispatching", values={"dispatch_subtask_id": "123"})
        await db.commit()
        assert attempt.subtask_id == "123"
        assert list(await db.scalars(select(PrintArchive.id))) == [attempt.id]
        assert copied.exists()


@pytest.mark.parametrize("close_only", [False, True])
async def test_rollback_discards_archive_row_and_prepared_files(alignment, close_only):
    db = alignment.sessions()
    job = await db.get(PrintQueueItem, alignment.job_id)
    async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
        await transition_queue_item(db, job, "queued", "dispatching", values={"printer_id": job.assigned_printer_id})
    await db.commit()
    prepared = await prepare_dispatch_archive(db, job)
    async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
        await link_dispatch_archive(db, job, prepared)
    attempt = await db.get(PrintArchive, job.archive_id)
    copied = settings.base_dir / attempt.file_path
    assert copied.exists()
    if not close_only:
        await db.rollback()
    await db.close()
    assert not copied.exists()
    async with alignment.sessions() as observer:
        assert (await observer.get(PrintQueueItem, alignment.job_id)).status == "dispatching"
        assert await observer.scalar(select(PrintArchive.id)) is None


@pytest.mark.parametrize(
    "outcome, archived", [("finished", "completed"), ("failed", "failed"), ("cancelled", "aborted")]
)
@pytest.mark.parametrize("automatic", [False, True])
async def test_outcome_commits_on_entry_and_plate_clear_does_not_rewrite_it(alignment, outcome, archived, automatic):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_printer(db, job.assigned_printer_id)
        db.add(Settings(key="require_plate_clear", value="false" if automatic else "true"))
        await hold_and_link(db, job)
        now = datetime.now(timezone.utc)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "printing", values={"started_at": now})
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "printing", "paused")
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "paused", outcome, values={"error_message": "HMS 0700_8012"})
        await db.commit()
        attempt = await db.get(PrintArchive, job.archive_id)
        assert attempt.status == archived and attempt.completed_at is not None
        if outcome == "failed":
            assert attempt.failure_reason == "HMS 0700_8012"
        snapshot = (attempt.status, attempt.started_at, attempt.completed_at, attempt.failure_reason)
        if job.status != "successful":
            assert alignment.source_path.exists()
            await clear_job_plate(db, job)
            await db.commit()
        assert job.status == ("successful" if outcome == "finished" else "unsuccessful")
        await db.refresh(attempt)
        assert (attempt.status, attempt.started_at, attempt.completed_at, attempt.failure_reason) == snapshot
        assert not alignment.source_path.exists()


async def test_completed_print_corrects_cancelled_attempt_archive(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "printing")
        await db.commit()
        await cancel_job(db, job)
        attempt = await db.get(PrintArchive, job.archive_id)
        assert job.status == "cancelled" and job.physical_outcome is None
        assert attempt.status == "aborted"

        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                job,
                "cancelled",
                "finished",
                action="printer_report",
                values={"error_message": None, "completed_at": datetime.now(timezone.utc)},
            )
        await db.commit()
        assert job.status == "finished" and job.physical_outcome == "completed"
        assert attempt.status == "completed" and attempt.failure_reason is None
        assert attempt.completed_at == job.physical_completed_at.replace(tzinfo=None)


async def test_cancelled_job_records_abort_only_after_matching_terminal_report(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "printing")
        await db.commit()
        await cancel_job(db, job)
        assert job.physical_outcome is None
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "cancelled", "cancelled", action="printer_report")
        await db.commit()
        assert job.physical_outcome == "aborted" and job.physical_completed_at is not None
        attempt = await db.get(PrintArchive, job.archive_id)
        assert attempt.status == "aborted" and attempt.completed_at == job.physical_completed_at.replace(tzinfo=None)
        with pytest.raises(QueueTransitionConflict):
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "cancelled", "finished", action="printer_report")


async def test_reprint_source_is_immutable_and_outcome_uses_both_link_columns(alignment):
    async with alignment.sessions() as db:
        source = await ArchiveService(db).archive_print(None, alignment.source_path, print_data={"status": "completed"})
        original = (source.status, source.completed_at, source.file_path)
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.library_file_id = None
        job.archive_id = source.id
        await db.commit()
        attempt = await hold_and_link(db, job)
        # Core reads must see the new attempt even before commit or ORM autoflush.
        with db.no_autoflush:
            linked_id = await db.scalar(
                select(PrintQueueItem.__table__.c.archive_id).where(PrintQueueItem.__table__.c.id == job.id)
            )
        assert linked_id == attempt.id
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "failed", values={"error_message": "Upload failed"})
        await db.commit()
        await db.refresh(source)
        assert attempt.id != source.id and attempt.status == "failed"
        assert (source.status, source.completed_at, source.file_path) == original
        # A legacy/source Archive with a different job link cannot be overwritten.
        other = PrintQueueItem(archive_id=attempt.id, status="printing")
        db.add(other)
        await db.flush()
        async with writer(getattr(other, "printer_id", None) or getattr(other, "assigned_printer_id", None)):
            await transition_queue_item(db, other, "printing", "finished")
        await db.commit()
        assert attempt.status == "failed"


@pytest.mark.parametrize(
    "status", ["queued", "preheating", "dispatching", "printing", "paused", "finished", "failed", "cancelled"]
)
async def test_any_nonfinal_variant_reference_retains_a_hidden_upload(alignment, status):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.library_file_id = None
        other = PrintQueueItem(status=status)
        db.add(other)
        await db.flush()
        db.add(PrintQueueVariant(queue_item_id=other.id, library_file_id=alignment.source_id, target_model="X1C"))
        await db.commit()
        assert await remove_queue_only_source_if_unused(db, alignment.source_id) == []
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "unsuccessful", action="cancel")
        await db.commit()
        assert alignment.source_path.exists()
        assert await db.get(LibraryFile, alignment.source_id) is not None


async def test_final_variant_releases_all_its_sources_after_commit(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.library_file_id = None
        db.add(PrintQueueVariant(queue_item_id=job.id, library_file_id=alignment.source_id, target_model="X1C"))
        await db.commit()
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "unsuccessful", action="cancel")
        assert alignment.source_path.exists()
        await db.commit()
        assert not alignment.source_path.exists()
        assert await db.get(LibraryFile, alignment.source_id) is None


async def test_preheat_failure_creates_no_archive_or_early_source_cleanup(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await enter_preheating(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "preheating", "failed", values={"error_message": "Heater failed"})
        await db.commit()
        assert await db.scalar(select(PrintArchive.id)) is None
        assert alignment.source_path.exists()


async def test_unsent_archive_copy_failure_retries_without_touching_source(alignment, monkeypatch):
    from backend.app.services.print_scheduler import PrintScheduler
    from backend.app.services.printer_manager import printer_manager

    monkeypatch.setattr(
        printer_manager,
        "get_status",
        lambda _id: SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True),
    )
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
    monkeypatch.setattr(ArchiveService, "archive_print", AsyncMock(side_effect=OSError("Disk full")))
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await PrintScheduler().workers.leave(db, job)
        assert job.status == "failed" and job.printer_id is not None and job.physical_outcome is None
        assert job.archive_id is None and alignment.source_path.exists()
        retry = await db.scalar(select(PrintQueueItem).where(PrintQueueItem.id != job.id))
        assert retry is not None and retry.status == "queued" and retry.retry_on_failure is False
        assert retry.printer_id is None and retry.assigned_printer_id == job.assigned_printer_id


@pytest.mark.parametrize(
    "state, archived",
    [
        ("printing", "printing"),
        ("paused", "printing"),
        ("finished", "completed"),
        ("successful", "completed"),
        ("failed", "failed"),
        ("cancelled", "aborted"),
    ],
)
async def test_late_external_archive_association_uses_the_jobs_committed_state(alignment, state, archived):
    async with alignment.sessions() as db:
        # An external download can finish after startup recovery saw its outcome.
        job = PrintQueueItem(
            status=state, started_at=datetime.now(timezone.utc), completed_at=datetime.now(timezone.utc)
        )
        db.add(job)
        await db.commit()
        archive = await ArchiveService(db).archive_print(None, alignment.source_path, print_data={"status": "printing"})
        archive.dispatched_queue_item_id = job.id
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, state, state, values={"archive_id": archive.id})
        await db.commit()
        assert archive.status == archived


@pytest.mark.parametrize("outcome", ["failed", "cancelled"])
@pytest.mark.parametrize("source_kind", ["file", "archive", "variants"])
async def test_retry_does_not_inherit_physical_outcome_even_when_cancelled_while_queued(
    alignment, outcome, source_kind
):
    from backend.app.api.routes.print_queue import retry_queue_item

    async with alignment.sessions() as db:
        old = await db.get(PrintQueueItem, alignment.job_id)
        if source_kind == "variants":
            db.add(PrintQueueVariant(queue_item_id=old.id, library_file_id=alignment.source_id, target_model="X1C"))
            await db.commit()
        await hold_and_link(db, old)
        async with writer(getattr(old, "printer_id", None) or getattr(old, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                old,
                "dispatching",
                outcome,
                values={
                    "error_message": "Original outcome",
                    "completed_at": datetime.now(timezone.utc).replace(tzinfo=None),
                },
            )
        await db.commit()
        original_facts = (old.physical_outcome, old.physical_completed_at, old.physical_failure_reason)
        assert all(original_facts)
        original_archive = await db.get(PrintArchive, old.archive_id)
        archive_facts = (original_archive.status, original_archive.completed_at, original_archive.failure_reason)
        if source_kind == "archive":
            alignment.source_path.unlink()
        result = await retry_queue_item(old.id, db=db, auth_result=(None, True), _=None)
        new = await db.get(PrintQueueItem, result.id)
        old_id, new_id, archive_id = old.id, new.id, old.archive_id
        assert new.id != old.id and new.status == "queued" and old.status == outcome
        assert (new.physical_outcome, new.physical_completed_at, new.physical_failure_reason) == (None, None, None)
        await cancel_job(db, new)
    async with alignment.sessions() as observer:
        new = await observer.get(PrintQueueItem, new_id)
        old = await observer.get(PrintQueueItem, old_id)
        original_archive = await observer.get(PrintArchive, archive_id)
        assert new.status == "unsuccessful" and old.status == outcome
        assert (new.physical_outcome, new.physical_completed_at, new.physical_failure_reason) == (None, None, None)
        assert (old.physical_outcome, old.physical_completed_at, old.physical_failure_reason) == original_facts
        assert original_archive.dispatched_queue_item_id == old.id
        assert (
            original_archive.status,
            original_archive.completed_at,
            original_archive.failure_reason,
        ) == archive_facts


async def test_archive_copy_failure_still_runs_configured_auto_off(alignment, monkeypatch):
    from backend.app.services.lifecycle import dispatching as sched
    from backend.app.services.print_scheduler import PrintScheduler
    from backend.app.services.printer_manager import printer_manager
    from backend.app.services.smart_plug_manager import smart_plug_manager

    live = SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True, raw_data={})
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "is_awaiting_plate_clear", lambda _id: False)
    monkeypatch.setattr(ArchiveService, "archive_print", AsyncMock(side_effect=OSError("Disk full")))
    scheduler = PrintScheduler()
    done = asyncio.Event()

    async def power_off_after_commit(_printer_id, _db):
        async with alignment.sessions() as observer:
            job = await observer.get(PrintQueueItem, alignment.job_id)
            assert job.status == "failed" and job.physical_outcome is None
            retry = await observer.scalar(select(PrintQueueItem).where(PrintQueueItem.id != job.id))
            assert retry is not None and retry.status == "queued" and retry.retry_on_failure is False
        done.set()

    off = AsyncMock(side_effect=power_off_after_commit)
    upload = AsyncMock()
    monkeypatch.setattr(smart_plug_manager, "schedule_off_after_queue_job", off)
    monkeypatch.setattr(sched, "upload_file_async", upload)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.auto_off_after = True
        await db.commit()
        await scheduler.workers.leave(db, job)
        assert job.status == "failed" and job.auto_off_after
        upload.assert_not_awaited()
        await asyncio.wait_for(done.wait(), 2)
        assert off.await_count == 1


@pytest.mark.parametrize(
    "outcome, archived", [("finished", "completed"), ("failed", "failed"), ("cancelled", "aborted")]
)
async def test_late_archive_uses_immutable_outcome_after_restart_and_display_updates(alignment, outcome, archived):
    started = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=2)
    completed = started + timedelta(minutes=1)
    async with alignment.sessions() as db:
        job = PrintQueueItem(status="printing", started_at=started)
        db.add(job)
        await db.commit()
        job_id = job.id
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                job,
                "printing",
                outcome,
                values={"completed_at": completed, "error_message": "Detailed printer error"},
                archive_failure_reason="HMS 0700_8012",
            )
        await db.commit()
    async with alignment.sessions() as user:
        job = await user.get(PrintQueueItem, job_id)
        await clear_job_plate(user, job)
        # Later bookkeeping/display metadata must not become a new outcome.
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                user,
                job,
                job.status,
                job.status,
                values={"error_message": "Printer hold transferred", "completed_at": completed + timedelta(seconds=5)},
            )
        await user.commit()
    async with alignment.sessions() as restarted:
        job = await restarted.get(PrintQueueItem, job_id)
        archive = await ArchiveService(restarted).archive_print(
            None, alignment.source_path, print_data={"status": "printing"}
        )
        archive.dispatched_queue_item_id = job.id
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(restarted, job, job.status, job.status, values={"archive_id": archive.id})
        await restarted.commit()
        assert (archive.status, archive.started_at, archive.completed_at) == (archived, started, completed)
        assert archive.failure_reason == (
            "HMS 0700_8012" if outcome == "failed" else "User cancelled" if outcome == "cancelled" else None
        )
