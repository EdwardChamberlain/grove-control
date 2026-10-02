"""Stage 5 Archive boundaries and source retention on real database sessions."""

import zipfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

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
from backend.app.services.queue_actions import cancel_job
from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused
from backend.app.services.queue_transitions import QueueTransitionConflict, clear_job_plate, transition_queue_item


@pytest.fixture
async def alignment(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    from backend.app.services.printer_manager import printer_manager

    monkeypatch.setattr(printer_manager, "get_status", lambda _id: None)
    monkeypatch.setattr(printer_manager, "stop_print", lambda _id: True)
    monkeypatch.setattr(printer_manager, "set_awaiting_plate_clear", lambda *_args: None)
    monkeypatch.setattr(printer_manager, "set_awaiting_plate_clear_archive_id", lambda *_args: None)
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
        job = PrintQueueItem(printer_id=printer.id, library_file_id=source.id, status="queued")
        db.add(job)
        await db.commit()
    yield SimpleNamespace(sessions=sessions, job_id=job.id, source_id=source.id, source_path=source_path)
    await engine.dispose()


@pytest.mark.parametrize("before", ["queued", "preheating"])
async def test_archive_and_hold_commit_together_and_same_state_never_copies_again(alignment, before):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if before == "preheating":
            await transition_queue_item(db, job, "queued", "preheating")
            await db.commit()
            assert await db.scalar(select(PrintArchive.id)) is None
        await transition_queue_item(db, job, before, "dispatching")
        attempt = await db.get(PrintArchive, job.archive_id)
        copied = settings.base_dir / attempt.file_path
        assert copied.read_bytes() == alignment.source_path.read_bytes()
        assert attempt.dispatched_queue_item_id == job.id and attempt.status == "dispatching"
        async with alignment.sessions() as observer:
            assert (await observer.get(PrintQueueItem, job.id)).status == before
            assert await observer.scalar(select(PrintArchive.id)) is None
        await db.commit()
        await transition_queue_item(db, job, "dispatching", "dispatching", values={"dispatch_subtask_id": "123"})
        await db.commit()
        assert attempt.subtask_id == "123"
        assert list(await db.scalars(select(PrintArchive.id))) == [attempt.id]
        assert copied.exists()


@pytest.mark.parametrize("close_only", [False, True])
async def test_rollback_discards_archive_row_and_prepared_files(alignment, close_only):
    db = alignment.sessions()
    job = await db.get(PrintQueueItem, alignment.job_id)
    await transition_queue_item(db, job, "queued", "dispatching")
    attempt = await db.get(PrintArchive, job.archive_id)
    copied = settings.base_dir / attempt.file_path
    assert copied.exists()
    if not close_only:
        await db.rollback()
    await db.close()
    assert not copied.exists()
    async with alignment.sessions() as observer:
        assert (await observer.get(PrintQueueItem, alignment.job_id)).status == "queued"
        assert await observer.scalar(select(PrintArchive.id)) is None


async def test_cancel_during_copy_wins_without_an_archive_or_losing_pending_row(alignment, monkeypatch):
    original = ArchiveService.archive_print

    async def cancel_during_copy(service, **kwargs):
        prepared = await original(service, **kwargs)
        async with alignment.sessions() as user:
            job = await user.get(PrintQueueItem, alignment.job_id)
            await cancel_job(user, job)
        return prepared

    monkeypatch.setattr(ArchiveService, "archive_print", cancel_during_copy)
    async with alignment.sessions() as worker:
        stale = await worker.get(PrintQueueItem, alignment.job_id)
        with pytest.raises(QueueTransitionConflict):
            await transition_queue_item(worker, stale, "queued", "dispatching")
        # A scheduler handling several jobs may commit after skipping a loser.
        await worker.commit()
    async with alignment.sessions() as db:
        assert (await db.get(PrintQueueItem, alignment.job_id)).status == "unsuccessful"
        assert await db.scalar(select(PrintArchive.id)) is None
    assert list(settings.archive_dir.rglob("*.3mf")) == []


@pytest.mark.parametrize(
    "outcome, archived", [("finished", "completed"), ("failed", "failed"), ("cancelled", "aborted")]
)
@pytest.mark.parametrize("automatic", [False, True])
async def test_outcome_commits_on_entry_and_plate_clear_does_not_rewrite_it(alignment, outcome, archived, automatic):
    async with alignment.sessions() as db:
        db.add(Settings(key="require_plate_clear", value="false" if automatic else "true"))
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "dispatching")
        now = datetime.now(timezone.utc)
        await transition_queue_item(db, job, "dispatching", "printing", values={"started_at": now})
        await transition_queue_item(db, job, "printing", "paused")
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


async def test_reprint_source_is_immutable_and_outcome_uses_both_link_columns(alignment):
    async with alignment.sessions() as db:
        source = await ArchiveService(db).archive_print(None, alignment.source_path, print_data={"status": "completed"})
        original = (source.status, source.completed_at, source.file_path)
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.library_file_id = None
        job.archive_id = source.id
        await db.commit()
        await transition_queue_item(db, job, "queued", "dispatching")
        attempt = await db.get(PrintArchive, job.archive_id)
        await transition_queue_item(db, job, "dispatching", "failed", values={"error_message": "Upload failed"})
        await db.commit()
        await db.refresh(source)
        assert attempt.id != source.id and attempt.status == "failed"
        assert (source.status, source.completed_at, source.file_path) == original
        # A legacy/source Archive with a different job link cannot be overwritten.
        other = PrintQueueItem(archive_id=attempt.id, status="printing")
        db.add(other)
        await db.flush()
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
        await transition_queue_item(db, job, "queued", "unsuccessful", action="cancel")
        assert alignment.source_path.exists()
        await db.commit()
        assert not alignment.source_path.exists()
        assert await db.get(LibraryFile, alignment.source_id) is None


async def test_preheat_failure_creates_no_archive_or_early_source_cleanup(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "preheating")
        await transition_queue_item(db, job, "preheating", "failed", values={"error_message": "Heater failed"})
        await db.commit()
        assert await db.scalar(select(PrintArchive.id)) is None
        assert alignment.source_path.exists()


async def test_archive_copy_failure_holds_the_first_job_without_touching_source(alignment, monkeypatch):
    monkeypatch.setattr(ArchiveService, "archive_print", AsyncMock(side_effect=OSError("Disk full")))
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "dispatching")
        await db.commit()
        assert job.status == "failed" and job.printer_id is not None
        assert job.archive_id is None and alignment.source_path.exists()


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
        await transition_queue_item(db, job, state, state, values={"archive_id": archive.id})
        await db.commit()
        assert archive.status == archived
