"""Restored active Archives are associated only by proven job identity."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event, select

from backend.app.core.database import (
    _migrate_queue_archive_outcomes,
    _migrate_queue_legacy_archive_links,
    _migrate_queue_lifecycle,
)
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.archive import ArchiveService
from backend.app.services.lifecycle.awaiting import clear_job_plate
from backend.app.services.lifecycle.engine import QueueTransitionConflict, transition_queue_item, writer
from backend.app.services.lifecycle.printing import bind_observed_id
from backend.app.services.print_scheduler import PrintScheduler, scheduler
from backend.app.services.queue_actions import cancel_job
from backend.app.services.queue_archive import prepare_dispatch_archive
from backend.tests.unit.test_queue_archive_alignment import alignment, hold_and_link  # noqa: F401


@pytest.fixture
async def legacy_unmigrated(alignment):
    async with alignment.sessions() as db:
        archive = await ArchiveService(db).archive_print(
            1, alignment.source_path, print_data={"status": "printing"}, subtask_id="123"
        )
        # Seed the persisted shape from before dispatch-attempt links existed.
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == alignment.job_id)
            .values(
                status="printing",
                printer_id=1,
                archive_id=archive.id,
                dispatch_subtask_id="123",
                started_at=archive.started_at,
            )
        )
        await db.commit()
        archive_id = archive.id
    async with alignment.sessions.kw["bind"].begin() as conn:
        await _migrate_queue_lifecycle(conn)
        await _migrate_queue_archive_outcomes(conn)
    return SimpleNamespace(**vars(alignment), archive_id=archive_id)


@pytest.fixture
async def legacy(legacy_unmigrated):
    async with legacy_unmigrated.sessions.kw["bind"].begin() as conn:
        await _migrate_queue_legacy_archive_links(conn)
    return legacy_unmigrated


async def test_legacy_archive_repair_runs_only_once(legacy_unmigrated):
    legacy = legacy_unmigrated
    async with legacy.sessions() as db:
        archive = await db.get(PrintArchive, legacy.archive_id)
        archive.subtask_id = "different-job"
        await db.commit()
    async with legacy.sessions.kw["bind"].begin() as conn:
        await _migrate_queue_legacy_archive_links(conn)
    async with legacy.sessions() as db:
        archive = await db.get(PrintArchive, legacy.archive_id)
        assert archive.dispatched_queue_item_id is None
        assert await db.scalar(select(Settings.value).where(Settings.key == "queue_legacy_archive_link_version")) == "2"
        archive.subtask_id = "123"
        await db.commit()
    async with legacy.sessions.kw["bind"].begin() as conn:
        await _migrate_queue_legacy_archive_links(conn)
    async with legacy.sessions() as db:
        assert (await db.get(PrintArchive, legacy.archive_id)).dispatched_queue_item_id is None


@pytest.mark.parametrize("previous_link_version", [None, "1"])
@pytest.mark.parametrize(
    "old_status,status,outcome",
    [("completed", "finished", "completed"), ("failed", "failed", "failed"), ("cancelled", "cancelled", "aborted")],
)
async def test_full_startup_repairs_terminal_legacy_archives(
    alignment, monkeypatch, previous_link_version, old_status, status, outcome
):
    from backend.app.core import database

    completed = datetime(2026, 10, 1, 12)
    engine = alignment.sessions.kw["bind"]
    # The old installation has run its schema migrations before storing prints,
    # including the Archive search-index triggers used by real startup.
    async with engine.begin() as conn:
        await database.run_migrations(conn)
    async with alignment.sessions() as db:
        archive = await ArchiveService(db).archive_print(
            1, alignment.source_path, print_data={"status": "printing"}, subtask_id="123"
        )
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == alignment.job_id)
            .values(
                status=old_status,
                printer_id=1,
                archive_id=archive.id,
                dispatch_subtask_id="123",
                completed_at=completed,
                error_message="Original failure" if outcome == "failed" else None,
            )
        )
        printer = await db.get(Printer, 1)
        printer.awaiting_plate_clear = True
        printer.awaiting_plate_clear_archive_id = archive.id
        await db.commit()
        archive_id = archive.id
    if previous_link_version:
        # Reproduce the shipped startup order: the link step misses this row,
        # then outcome backfill supplies the facts after its marker was saved.
        async with engine.begin() as conn:
            await _migrate_queue_lifecycle(conn)
            await _migrate_queue_legacy_archive_links(conn)
            await conn.execute(
                Settings.__table__.update()
                .where(Settings.key == "queue_legacy_archive_link_version")
                .values(value=previous_link_version)
            )
            await _migrate_queue_archive_outcomes(conn)
    monkeypatch.setattr(database, "engine", engine)
    for name in (
        "_migrate_encrypt_legacy_secrets",
        "seed_notification_templates",
        "seed_default_groups",
        "seed_spool_catalog",
        "seed_color_catalog",
    ):
        monkeypatch.setattr(database, name, AsyncMock())
    await database.init_db()
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        archive = await db.get(PrintArchive, archive_id)
        assert (job.status, job.physical_outcome) == (status, outcome)
        assert (archive.status, archive.dispatched_queue_item_id, archive.completed_at) == (outcome, job.id, completed)
        assert await db.scalar(select(Settings.value).where(Settings.key == "queue_legacy_archive_link_version")) == "2"


@pytest.mark.parametrize("outcome", ["completed", "failed", "aborted"])
@pytest.mark.parametrize("linked", [False, True])
async def test_restored_active_archive_follows_real_completion_callback(legacy, monkeypatch, outcome, linked):
    import backend.app.main as main
    import backend.app.services.usage_tracker as usage
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake
    from backend.app.services.printer_manager import printer_manager

    if linked:
        async with legacy.sessions() as db:
            (await db.get(PrintArchive, legacy.archive_id)).dispatched_queue_item_id = legacy.job_id
            await db.commit()
    live = SimpleNamespace(
        connected=True,
        job_telemetry_ready=True,
        state="FINISH" if outcome == "completed" else "FAILED",
        submission_id="123",
        subtask_id="123",
        raw_data={},
    )
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(printer_manager, "get_printer", lambda _id: None)
    monkeypatch.setattr(intake, "async_session", legacy.sessions)
    monkeypatch.setattr(print_effects, "async_session", legacy.sessions)
    monkeypatch.setattr(print_effects, "_report_spoolman_usage", AsyncMock())
    monkeypatch.setattr(print_effects, "_cleanup_spoolman_tracking", AsyncMock())
    monkeypatch.setattr(usage, "on_print_complete", AsyncMock(return_value=[]))
    monkeypatch.setattr(usage, "discard_session", AsyncMock())
    monkeypatch.setattr(main.notification_service, "on_queue_completed", AsyncMock())
    monkeypatch.setattr(main.notification_service, "_get_providers_for_event", AsyncMock(return_value=[]))
    monkeypatch.setattr(main.ws_manager, "send_print_complete", AsyncMock())
    published = AsyncMock()
    monkeypatch.setattr(main.ws_manager, "send_archive_updated", published)
    monkeypatch.setattr(main.mqtt_relay, "on_queue_job_completed", AsyncMock())
    monkeypatch.setattr(main.mqtt_relay, "on_archive_updated", AsyncMock())
    monkeypatch.setattr(print_effects, "spawn_background_task", lambda coroutine, **_kwargs: coroutine.close())

    # No filename/subtask name: there is no remote file to delete in this test.
    await main.on_print_complete(1, {"submission_id": "123", "status": outcome})
    async with legacy.sessions() as observer:
        job = await observer.get(PrintQueueItem, legacy.job_id)
        archive = await observer.get(PrintArchive, legacy.archive_id)
        assert job.status == {"completed": "finished", "failed": "failed", "aborted": "cancelled"}[outcome]
        assert archive.dispatched_queue_item_id == job.id
        assert archive.status == outcome and archive.completed_at == job.physical_completed_at
        assert archive.started_at == job.started_at
        log = await observer.scalar(select(PrintLogEntry).where(PrintLogEntry.queue_item_id == job.id))
        assert log.status == outcome and log.completed_at == archive.completed_at
        published.assert_awaited_once_with({"id": archive.id, "status": outcome})
        snapshot = (archive.status, archive.started_at, archive.completed_at, archive.failure_reason)
        await clear_job_plate(observer, job)
        await observer.commit()
        await observer.refresh(archive)
        assert (archive.status, archive.started_at, archive.completed_at, archive.failure_reason) == snapshot


@pytest.mark.parametrize("path", ["stop", "recovery", "pause", "clear_plate"])
async def test_legacy_link_and_outcome_commit_through_independent_lifecycle_paths(legacy, monkeypatch, path):
    from backend.app.services.lifecycle import dispatching as scheduling
    from backend.app.services.printer_manager import printer_manager

    async with legacy.sessions() as db:
        job = await db.get(PrintQueueItem, legacy.job_id)
        if path == "stop":
            await cancel_job(db, job)
        elif path == "recovery":
            live = SimpleNamespace(
                connected=True, job_telemetry_ready=True, state="FAILED", submission_id="123", raw_data={}
            )
            monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
            monkeypatch.setattr(scheduling, "spawn_background_task", lambda coroutine, **_kwargs: coroutine.close())
            await PrintScheduler().dispatcher.recover(db)
        elif path == "pause":
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "printing", "paused")
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "paused", "finished")
            await db.commit()
        else:
            completed = datetime.now(timezone.utc).replace(tzinfo=None)
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "printing", "failed", values={"completed_at": completed})
            await clear_job_plate(db, job)
            await db.commit()
    async with legacy.sessions() as observer:
        job = await observer.get(PrintQueueItem, legacy.job_id)
        archive = await observer.get(PrintArchive, legacy.archive_id)
        assert archive.dispatched_queue_item_id == job.id
        assert (
            archive.status
            == {"stop": "aborted", "recovery": "failed", "pause": "completed", "clear_plate": "failed"}[path]
        )
        assert archive.completed_at == (job.completed_at if path == "stop" else job.physical_completed_at)


async def test_migrated_link_survives_a_rolled_back_job_outcome(legacy):
    async with legacy.sessions() as db:
        job = await db.get(PrintQueueItem, legacy.job_id)
        # Include a preloaded Archive to catch stale identity-map projections.
        archive = await db.get(PrintArchive, legacy.archive_id)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "printing", "failed")
        assert archive.dispatched_queue_item_id == job.id and archive.status == "failed"
        await db.rollback()
    async with legacy.sessions() as observer:
        assert (await observer.get(PrintQueueItem, legacy.job_id)).status == "printing"
        archive = await observer.get(PrintArchive, legacy.archive_id)
        assert archive.dispatched_queue_item_id == legacy.job_id and archive.status == "printing"
        assert archive.completed_at is None


async def test_stale_completion_cannot_rewrite_a_legacy_stop_outcome(legacy):
    async with legacy.sessions() as stale:
        job = await stale.get(PrintQueueItem, legacy.job_id)
        async with legacy.sessions() as user:
            await cancel_job(user, await user.get(PrintQueueItem, legacy.job_id))
        with pytest.raises(QueueTransitionConflict):
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(stale, job, "printing", "failed")
        await stale.commit()
    async with legacy.sessions() as observer:
        job = await observer.get(PrintQueueItem, legacy.job_id)
        archive = await observer.get(PrintArchive, legacy.archive_id)
        assert job.status == "cancelled" and archive.status == "aborted"
        assert archive.dispatched_queue_item_id == job.id
        assert job.physical_outcome is None and archive.completed_at == job.completed_at


async def test_late_firmware_identity_binds_the_legacy_archive_in_the_same_transaction(legacy):
    async with legacy.sessions() as db:
        await bind_observed_id(db, 1, "456", "123")
        job = await db.get(PrintQueueItem, legacy.job_id)
        archive = await db.get(PrintArchive, legacy.archive_id)
        assert job.dispatch_subtask_id == archive.subtask_id == "456"
        assert archive.dispatched_queue_item_id == job.id
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "printing", "failed")
        await db.commit()
    async with legacy.sessions() as observer:
        archive = await observer.get(PrintArchive, legacy.archive_id)
        assert archive.subtask_id == "456" and archive.status == "failed"


@pytest.mark.parametrize(
    "mismatch",
    [
        "missing_id",
        "zero_id",
        "different_id",
        "different_printer",
        "source",
        "deleted",
        "owned",
        "duplicate_archive",
        "duplicate_job",
        "other_attempt",
    ],
)
async def test_legacy_association_does_not_guess_or_modify_another_attempt(legacy_unmigrated, mismatch):
    legacy = legacy_unmigrated
    async with legacy.sessions() as db:
        job = await db.get(PrintQueueItem, legacy.job_id)
        archive = await db.get(PrintArchive, legacy.archive_id)
        if mismatch == "missing_id":
            job.dispatch_subtask_id = None
        elif mismatch == "zero_id":
            job.dispatch_subtask_id = archive.subtask_id = "0"
        elif mismatch == "different_id":
            archive.subtask_id = "other"
        elif mismatch == "different_printer":
            db.add(Printer(id=2, name="Other", serial_number="OTHER", ip_address="127.0.0.2", access_code="code"))
            await db.flush()
            archive.printer_id = 2
        elif mismatch == "source":
            archive.status = "completed"
            archive.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        elif mismatch == "deleted":
            archive.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
        elif mismatch in ("owned", "duplicate_job"):
            other = PrintQueueItem(
                printer_id=1, status="successful", dispatch_subtask_id="123" if mismatch == "duplicate_job" else "other"
            )
            db.add(other)
            await db.flush()
            if mismatch == "owned":
                archive.dispatched_queue_item_id = other.id
        else:
            db.add(
                PrintArchive(
                    printer_id=1,
                    filename="source.3mf",  # Same filename supplies no identity proof.
                    file_path="",
                    file_size=0,
                    status="completed",
                    subtask_id="123" if mismatch == "duplicate_archive" else "other",
                    dispatched_queue_item_id=job.id if mismatch == "other_attempt" else None,
                )
            )
        await db.commit()
        original = (archive.status, archive.subtask_id, archive.dispatched_queue_item_id, archive.completed_at)
        async with legacy.sessions.kw["bind"].begin() as conn:
            await _migrate_queue_legacy_archive_links(conn)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "printing", "failed")
        await db.commit()
        await db.refresh(archive)
        assert (archive.status, archive.subtask_id, archive.dispatched_queue_item_id, archive.completed_at) == original
        assert job.status == "failed" and job.physical_outcome == "failed"


@pytest.mark.parametrize(
    "status,outcome",
    [
        ("finished", "completed"),
        ("failed", "failed"),
        ("cancelled", "aborted"),
        ("successful", "completed"),
        ("unsuccessful", "failed"),
        ("unsuccessful", "aborted"),
    ],
)
async def test_upgrade_repairs_terminal_legacy_archive_without_replaying_completion(
    legacy_unmigrated, monkeypatch, status, outcome
):
    legacy = legacy_unmigrated
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake, printing as lifecycle_printing
    from backend.app.services.printer_manager import printer_manager

    completed = datetime(2026, 10, 1, 12)
    reason = "Original HMS failure" if outcome == "failed" else "User cancelled" if outcome == "aborted" else None
    live = SimpleNamespace(
        connected=True,
        job_telemetry_ready=True,
        state="FINISH" if outcome == "completed" else "FAILED",
        submission_id="123",
        subtask_id="123",
        raw_data={},
    )
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(intake, "async_session", legacy.sessions)
    monkeypatch.setattr(print_effects, "async_session", legacy.sessions)
    notified, completed_event, relayed = AsyncMock(), AsyncMock(), AsyncMock()
    usage = AsyncMock()
    monkeypatch.setattr(main.notification_service, "on_queue_completed", notified)
    monkeypatch.setattr(main.ws_manager, "send_print_complete", completed_event)
    monkeypatch.setattr(main.mqtt_relay, "on_queue_job_completed", relayed)
    monkeypatch.setattr(lifecycle_printing, "_bump_library_file_usage_if_completed", usage)
    monkeypatch.setattr(print_effects, "spawn_background_task", lambda coroutine, **_kwargs: coroutine.close())
    async with legacy.sessions() as db:
        job = await db.get(PrintQueueItem, legacy.job_id)
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == job.id)
            .values(
                status=status,
                completed_at=completed,
                error_message="Original display reason",
                physical_outcome=outcome,
                physical_completed_at=completed,
                physical_failure_reason=reason,
            )
        )
        await db.commit()
        await db.refresh(job)
        snapshot = (
            job.status,
            job.completed_at,
            job.error_message,
            job.physical_outcome,
            job.physical_completed_at,
            job.physical_failure_reason,
        )
    async with legacy.sessions.kw["bind"].begin() as conn:
        await _migrate_queue_legacy_archive_links(conn)
    # A conflicting late report must neither rewrite facts nor replay effects.
    await main.on_print_complete(
        1, {"submission_id": "123", "status": "failed" if outcome == "completed" else "completed"}
    )
    async with legacy.sessions() as db:
        job = await db.get(PrintQueueItem, legacy.job_id)
        archive = await db.get(PrintArchive, legacy.archive_id)
        assert archive.dispatched_queue_item_id == job.id and archive.status == outcome
        assert archive.completed_at == completed and archive.failure_reason == reason
        assert archive.started_at == job.started_at
        assert (
            job.status,
            job.completed_at,
            job.error_message,
            job.physical_outcome,
            job.physical_completed_at,
            job.physical_failure_reason,
        ) == snapshot
        assert await db.scalar(select(PrintLogEntry.id)) is None
    for effect in (notified, completed_event, relayed, usage):
        effect.assert_not_awaited()


@pytest.mark.parametrize("duplicate", ["archive", "job"])
async def test_upgrade_rejects_ambiguous_terminal_legacy_identity(legacy_unmigrated, monkeypatch, duplicate):
    legacy = legacy_unmigrated
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake
    from backend.app.services.printer_manager import printer_manager

    monkeypatch.setattr(
        printer_manager,
        "get_status",
        lambda _id: SimpleNamespace(
            connected=True, job_telemetry_ready=True, state="FAILED", submission_id="123", raw_data={}
        ),
    )
    monkeypatch.setattr(intake, "async_session", legacy.sessions)
    monkeypatch.setattr(print_effects, "async_session", legacy.sessions)
    completed = datetime(2026, 10, 1, 12)
    async with legacy.sessions() as db:
        await db.execute(
            PrintQueueItem.__table__.update()
            .where(PrintQueueItem.id == legacy.job_id)
            .values(status="failed", physical_outcome="failed", physical_completed_at=completed)
        )
        if duplicate == "archive":
            db.add(
                PrintArchive(
                    printer_id=1, filename="other.3mf", file_path="", file_size=0, status="printing", subtask_id="123"
                )
            )
        else:
            db.add(PrintQueueItem(printer_id=1, status="successful", dispatch_subtask_id="123"))
        await db.commit()
    async with legacy.sessions.kw["bind"].begin() as conn:
        await _migrate_queue_legacy_archive_links(conn)
    async with legacy.sessions() as db:
        archive = await db.get(PrintArchive, legacy.archive_id)
        job = await db.get(PrintQueueItem, legacy.job_id)
        assert archive.dispatched_queue_item_id is None and archive.status == "printing"
        assert job.status == "failed" and job.physical_completed_at == completed


@pytest.mark.parametrize("status", ["finished", "failed", "successful", "unsuccessful"])
async def test_duplicate_modern_completion_needs_no_write_transaction(alignment, monkeypatch, status):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake, printing as lifecycle_printing
    from backend.app.services.printer_manager import printer_manager

    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        attempt = await hold_and_link(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "printing", values={"dispatch_subtask_id": "123"})
        awaiting = "finished" if status in ("finished", "successful") else "failed"
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "printing", awaiting, values={"error_message": "Original reason"})
        if status in ("successful", "unsuccessful"):
            await clear_job_plate(db, job)
        await db.commit()
        await db.refresh(job)
        await db.refresh(attempt)
        before_job = (
            job.status,
            job.archive_id,
            job.error_message,
            job.physical_outcome,
            job.physical_completed_at,
            job.physical_failure_reason,
        )
        before_archive = (
            attempt.status,
            attempt.dispatched_queue_item_id,
            attempt.started_at,
            attempt.completed_at,
            attempt.failure_reason,
        )

    monkeypatch.setattr(intake, "async_session", alignment.sessions)
    monkeypatch.setattr(print_effects, "async_session", alignment.sessions)
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: None)
    notified, published, usage = AsyncMock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(main.notification_service, "on_queue_completed", notified)
    monkeypatch.setattr(main.ws_manager, "send_print_complete", published)
    monkeypatch.setattr(lifecycle_printing, "_bump_library_file_usage_if_completed", usage)
    statements = []

    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    engine = alignment.sessions.kw["bind"].sync_engine
    event.listen(engine, "before_cursor_execute", capture)
    try:
        assert await main.on_print_complete(1, {"submission_id": "123", "status": "completed"}) is False
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert not [sql for sql in statements if sql.lstrip().upper().startswith("UPDATE")]
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        attempt = await db.get(PrintArchive, job.archive_id)
        assert (
            job.status,
            job.archive_id,
            job.error_message,
            job.physical_outcome,
            job.physical_completed_at,
            job.physical_failure_reason,
        ) == before_job
        assert (
            attempt.status,
            attempt.dispatched_queue_item_id,
            attempt.started_at,
            attempt.completed_at,
            attempt.failure_reason,
        ) == before_archive
    for effect in (notified, published, usage):
        effect.assert_not_awaited()
