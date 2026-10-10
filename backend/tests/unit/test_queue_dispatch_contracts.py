"""Source eligibility, copy failures, and heat-soak dispatch contracts."""

import asyncio
import errno
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.routes.print_queue import skip_queue_item_heat_soak
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem, physical_holding_clause
from backend.app.models.printer import Printer
from backend.app.services.archive import ArchiveService
from backend.app.services.lifecycle import (
    dispatching as scheduling,
    effects as lifecycle_effects,
    preheating as heat,
    queued as lifecycle_queued,
)
from backend.app.services.lifecycle.engine import InvalidQueueTransition, transition_queue_item, writer
from backend.app.services.print_scheduler import PrintScheduler, scheduler
from backend.app.services.queue_archive import link_dispatch_archive, prepare_dispatch_archive
from backend.tests.unit.test_lifecycle_preheating import enter_preheating
from backend.tests.unit.test_queue_archive_alignment import alignment  # noqa: F401
from backend.tests.unit.test_queue_dispatch_races import handoff  # noqa: F401


@pytest.mark.parametrize("heat_soak", [False, True])
@pytest.mark.parametrize("cached_source", [False, True])
async def test_trashed_reprint_stays_parked_without_a_printer_hold(handoff, monkeypatch, heat_soak, cached_source):
    scheduler = handoff.scheduler
    assigned, failed = AsyncMock(), AsyncMock()
    monkeypatch.setattr(lifecycle_queued, "notify_assignment", assigned)
    monkeypatch.setattr(lifecycle_effects.notification_service, "on_queue_job_failed", failed)
    async with handoff.sessions() as db:
        source = await ArchiveService(db).archive_print(None, handoff.source_path)
        if not cached_source:
            source.deleted_at = heat.utcnow()
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == handoff.job_id)
            .values(
                status="queued",
                printer_id=None,
                assigned_printer_id=None,
                archive_id=source.id,
                library_file_id=None,
                chamber_heat_soak=heat_soak,
            )
        )
        await db.commit()
        if cached_source:
            async with handoff.sessions() as trash:
                (await trash.get(PrintArchive, source.id)).deleted_at = heat.utcnow()
                await trash.commit()
            assert source.deleted_at is None  # Retained identity-map snapshot.
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        binding = lifecycle_queued._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await scheduler.workers.leave(db, job, binding=binding)
        await db.refresh(job)
        assert job.status == "queued" and job.printer_id is None and job.manual_start
        assert "deleted" in job.waiting_reason.lower()
        assert job.physical_outcome is None and job.archive_id == source.id
        assert await db.scalar(select(PrintQueueItem.id).where(PrintQueueItem.status.in_(HOLDING_STATUSES))) is None
        assert list(await db.scalars(select(PrintArchive.id))) == [source.id]
        assigned.assert_not_awaited()
        failed.assert_not_awaited()


@pytest.mark.parametrize("source_kind", ["archive", "library"])
@pytest.mark.parametrize("remove", ["trash", "delete"])
async def test_source_removed_after_eligibility_read_fails_the_committed_hold(
    handoff, monkeypatch, source_kind, remove
):
    from backend.app.services import queue_archive
    from backend.app.services.print_scheduler import scheduler as process_scheduler
    from backend.tests.unit.test_scheduler_cleanup_library import _wait_for_dispatch

    monkeypatch.setattr(process_scheduler.dispatcher, "schedule_stage", handoff.schedule_stage)

    model = PrintArchive if source_kind == "archive" else LibraryFile
    assigned = AsyncMock()
    monkeypatch.setattr(lifecycle_queued, "notify_assignment", assigned)
    async with handoff.sessions() as db:
        source_id = handoff.source_id
        if source_kind == "archive":
            source_id = (await ArchiveService(db).archive_print(None, handoff.source_path)).id
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == handoff.job_id)
            .values(
                status="queued",
                printer_id=None,
                assigned_printer_id=None,
                chamber_heat_soak=False,
                archive_id=source_id if source_kind == "archive" else None,
                library_file_id=source_id if source_kind == "library" else None,
            )
        )
        await db.commit()
        original = queue_archive.prepare_dispatch_archive

        async def remove_before_preparation(db, item):
            async with handoff.sessions() as user:
                source = await user.get(model, source_id)
                if remove == "trash":
                    source.deleted_at = heat.utcnow()
                else:
                    await user.delete(source)
                await user.commit()
            return await original(db, item)

        monkeypatch.setattr(queue_archive, "prepare_dispatch_archive", remove_before_preparation)
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        binding = lifecycle_queued._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await handoff.scheduler.workers.leave(db, job, binding=binding)
        await _wait_for_dispatch(SimpleNamespace(queue_item_id=handoff.job_id))
        await db.refresh(job)
        assert job.status == "failed" and job.printer_id == 1
        cause = "Dispatch source was deleted" if remove == "trash" else "Dispatch source no longer exists"
        assert job.error_message == f"Failed to create Archive record for dispatch: {cause}"
        assert job.physical_outcome is None
        retry = await db.scalar(select(PrintQueueItem).where(PrintQueueItem.id != job.id))
        assert retry is not None and retry.status == "queued" and retry.retry_on_failure is False
        assert (
            await db.scalar(
                select(PrintQueueItem.id).where(
                    physical_holding_clause(PrintQueueItem.status, PrintQueueItem.physical_outcome)
                )
            )
            is None
        )
        assert await db.scalar(select(PrintArchive.id).where(PrintArchive.dispatched_queue_item_id == job.id)) is None
        assigned.assert_not_awaited()


@pytest.mark.parametrize("before", ["queued", "preheating"])
async def test_dispatch_entry_holds_the_printer_before_creating_an_attempt(alignment, before):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if before == "preheating":
            await enter_preheating(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, before, "dispatching")
        await db.commit()
        await db.refresh(job)
        assert job.status == "dispatching" and job.archive_id is None
        assert await db.scalar(select(PrintArchive.id)) is None


async def test_dispatch_entry_rejects_another_jobs_prepared_archive(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        db.add(Printer(id=2, name="Other", serial_number="OTHER", ip_address="127.0.0.2", access_code="code"))
        other = PrintQueueItem(assigned_printer_id=2, library_file_id=alignment.source_id, status="queued")
        db.add(other)
        await db.commit()
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "queued", "dispatching")
        async with writer(getattr(other, "printer_id", None) or getattr(other, "assigned_printer_id", None)):
            await transition_queue_item(db, other, "queued", "dispatching")
        await db.commit()
        attempt = await prepare_dispatch_archive(db, other)
        with pytest.raises(InvalidQueueTransition, match="does not belong"):
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await link_dispatch_archive(db, job, attempt)
        await db.rollback()
    assert not list(settings.archive_dir.rglob("*.3mf"))


async def test_dispatch_entry_rejects_explicitly_clearing_the_selected_printer(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        with pytest.raises(InvalidQueueTransition, match="selected printer"):
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "queued", "dispatching", values={"printer_id": None})
        await db.rollback()
    async with alignment.sessions() as observer:
        job = await observer.get(PrintQueueItem, alignment.job_id)
        assert job.status == "queued" and job.printer_id is None and job.assigned_printer_id == 1
        assert job.archive_id is None
        assert await observer.scalar(select(PrintArchive.id)) is None
    assert not list(settings.archive_dir.rglob("*.3mf"))
