"""Dispatch contracts retained after moving preparation out of the writer."""

from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.routes.print_queue import skip_queue_item_heat_soak
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem
from backend.app.services import chamber_heat_soak as heat, print_scheduler as scheduling
from backend.app.services.archive import ArchiveService
from backend.app.services.queue_archive import prepare_dispatch_archive
from backend.app.services.queue_transitions import InvalidQueueTransition, transition_queue_item
from backend.tests.unit.test_queue_archive_alignment import alignment  # noqa: F401
from backend.tests.unit.test_queue_archive_review_fixes import handoff  # noqa: F401
from backend.tests.unit.test_queue_legacy_archive_alignment import legacy  # noqa: F401


@pytest.mark.parametrize("heat_soak", [False, True])
@pytest.mark.parametrize("cached_source", [False, True])
async def test_trashed_reprint_stays_parked_without_a_printer_hold(handoff, monkeypatch, heat_soak, cached_source):
    scheduler = handoff.scheduler
    assigned, failed, power_off = AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(scheduler, "_notify_pool_assignment", assigned)
    monkeypatch.setattr(scheduler, "_power_off_if_needed", power_off)
    monkeypatch.setattr(scheduling.notification_service, "on_queue_job_failed", failed)
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
                archive_id=source.id,
                library_file_id=None,
                chamber_heat_soak=heat_soak,
                preheat_owner=None,
            )
        )
        await db.commit()
        if cached_source:
            async with handoff.sessions() as trash:
                (await trash.get(PrintArchive, source.id)).deleted_at = heat.utcnow()
                await trash.commit()
            assert source.deleted_at is None  # Retained identity-map snapshot.
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        binding = scheduling._DispatchBinding.for_item(job, 1, None, unassigned=True)
        await scheduler._start_print(db, job, binding=binding)
        await db.refresh(job)
        assert job.status == "queued" and job.printer_id is None and job.manual_start
        assert "deleted" in job.waiting_reason.lower()
        assert job.physical_outcome is None and job.archive_id == source.id
        assert await db.scalar(select(PrintQueueItem.id).where(PrintQueueItem.status.in_(HOLDING_STATUSES))) is None
        assert list(await db.scalars(select(PrintArchive.id))) == [source.id]
        assigned.assert_not_awaited()
        failed.assert_not_awaited()
        power_off.assert_not_awaited()


@pytest.mark.parametrize("path", ["ordinary", "tick", "skip"])
async def test_preparation_failure_preserves_the_cause_in_job_and_response(handoff, monkeypatch, path):
    copy = AsyncMock(side_effect=OSError("Disk full"))
    monkeypatch.setattr(ArchiveService, "archive_print", copy)
    monkeypatch.setattr(handoff.scheduler, "_power_off_if_needed", AsyncMock())
    monkeypatch.setattr(scheduling.notification_service, "on_queue_job_failed", AsyncMock())
    # Skip imports the process-wide scheduler for the configured Auto Off.
    monkeypatch.setattr(scheduling.scheduler, "_power_off_if_needed", AsyncMock())
    async with handoff.sessions() as db:
        if path == "ordinary":
            await db.execute(
                PrintQueueItem.__table__.update()
                .where(PrintQueueItem.id == handoff.job_id)
                .values(status="queued", chamber_heat_soak=False, preheat_owner=None)
            )
            await db.commit()
            job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
            await handoff.scheduler._start_print(db, job)
        elif path == "tick":
            assert await handoff.service.check(db) == []
        else:
            with pytest.raises(HTTPException) as failure:
                await skip_queue_item_heat_soak(handoff.job_id, db=db, auth_result=(None, True))
            assert failure.value.status_code == 409
            assert "Disk full" in failure.value.detail
        job = await db.get(PrintQueueItem, handoff.job_id, populate_existing=True)
        assert job.status == "failed" and "Disk full" in job.error_message
        assert "Disk full" in job.physical_failure_reason
        assert await db.scalar(select(PrintArchive.id)) is None
        copy.assert_awaited_once()


@pytest.mark.parametrize("status,outcome", [("finished", "completed"), ("failed", "failed"), ("cancelled", "aborted")])
@pytest.mark.parametrize("ambiguous", [False, True])
async def test_same_status_completion_repairs_only_proven_legacy_attempt(legacy, status, outcome, ambiguous):
    async with legacy.sessions() as db:
        job = await db.get(PrintQueueItem, legacy.job_id)
        completed = heat.utcnow() - timedelta(minutes=1)
        reason = "Original failure" if outcome == "failed" else "User cancelled" if outcome == "aborted" else None
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == job.id)
            .values(
                status=status,
                completed_at=completed,
                physical_outcome=outcome,
                physical_completed_at=completed,
                physical_failure_reason=reason,
            )
        )
        if ambiguous:
            db.add(
                PrintArchive(
                    printer_id=1, filename="other.3mf", file_path="", file_size=0, status="completed", subtask_id="123"
                )
            )
        await db.commit()
        await db.refresh(job)
        snapshot = (job.physical_outcome, job.physical_completed_at, job.physical_failure_reason)
        await transition_queue_item(
            db, job, status, status, values={"completed_at": completed, "error_message": "Late telemetry"}
        )
        await db.commit()
        archive = await db.get(PrintArchive, legacy.archive_id)
        if ambiguous:
            assert archive.dispatched_queue_item_id is None and archive.status == "printing"
        else:
            assert archive.dispatched_queue_item_id == job.id and archive.status == outcome
            assert archive.completed_at == job.physical_completed_at and archive.failure_reason == reason
        assert (job.physical_outcome, job.physical_completed_at, job.physical_failure_reason) == snapshot


@pytest.mark.parametrize("phase", ["before_request", "during_copy"])
@pytest.mark.parametrize("progressed", ["dispatching", "printing", "paused"])
async def test_skip_is_successful_when_the_same_soak_already_progressed(handoff, monkeypatch, phase, progressed):
    async def advance():
        async with handoff.sessions() as worker:
            assert await handoff.service.check(worker) == [handoff.job_id]
            job = await worker.get(PrintQueueItem, handoff.job_id)
            if progressed != "dispatching":
                await transition_queue_item(worker, job, "dispatching", "printing")
                if progressed == "paused":
                    await transition_queue_item(worker, job, "printing", "paused")
                await worker.commit()

    if phase == "before_request":
        await advance()
    else:
        original = ArchiveService.archive_print
        copying = False

        async def finish_during_copy(service, **kwargs):
            nonlocal copying
            attempt = await original(service, **kwargs)
            if not copying:
                copying = True
                await advance()
            return attempt

        monkeypatch.setattr(ArchiveService, "archive_print", finish_during_copy)
    spawned = []

    def collect(coroutine, **kwargs):
        spawned.append(kwargs)
        coroutine.close()

    monkeypatch.setattr(heat, "spawn_background_task", collect)
    async with handoff.sessions() as db:
        response = await skip_queue_item_heat_soak(handoff.job_id, db=db, auth_result=(None, True))
        assert response == {"message": "Heat soak skipped"}
    async with handoff.sessions() as observer:
        job = await observer.get(PrintQueueItem, handoff.job_id)
        assert job.status == progressed
        attempts = list(await observer.scalars(select(PrintArchive)))
        assert len(attempts) == 1 and attempts[0].dispatched_queue_item_id == job.id
        assert (settings.base_dir / attempts[0].file_path).exists()
    assert len(list((settings.archive_dir / "1").iterdir())) == 1
    assert not any(call["name"].startswith("skip-heat-soak-dispatch-") for call in spawned)


@pytest.mark.parametrize("before", ["queued", "preheating"])
async def test_dispatch_entry_requires_an_explicit_prepared_attempt(alignment, before):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if before == "preheating":
            await transition_queue_item(db, job, "queued", "preheating")
            await db.commit()
        with pytest.raises(InvalidQueueTransition, match="prepared Archive"):
            await transition_queue_item(db, job, before, "dispatching")
        await db.commit()
        await db.refresh(job)
        assert job.status == before and job.archive_id is None
        assert await db.scalar(select(PrintArchive.id)) is None


async def test_dispatch_entry_rejects_another_jobs_prepared_archive(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        other = PrintQueueItem(printer_id=1, library_file_id=alignment.source_id, status="queued")
        db.add(other)
        await db.commit()
        attempt = await prepare_dispatch_archive(db, other, {})
        with pytest.raises(InvalidQueueTransition, match="prepared Archive"):
            await transition_queue_item(db, job, "queued", "dispatching", attempt=attempt)
        await db.rollback()
    assert not list(settings.archive_dir.rglob("*.3mf"))


async def test_dispatch_entry_rejects_explicitly_clearing_the_selected_printer(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        attempt = await prepare_dispatch_archive(db, job, {})
        with pytest.raises(InvalidQueueTransition, match="prepared Archive"):
            await transition_queue_item(db, job, "queued", "dispatching", values={"printer_id": None}, attempt=attempt)
        await db.rollback()
    async with alignment.sessions() as observer:
        job = await observer.get(PrintQueueItem, alignment.job_id)
        assert job.status == "queued" and job.printer_id == 1 and job.archive_id is None
        assert await observer.scalar(select(PrintArchive.id)) is None
    assert not list(settings.archive_dir.rglob("*.3mf"))
