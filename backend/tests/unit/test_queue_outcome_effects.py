"""Committed queue outcomes own notification, power, heaters, and SD cleanup."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from backend.app.models.archive import PrintArchive
from backend.app.models.notification import NotificationProvider
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import (
    effects as queue_outcome_effects,
    preheating as heat,
)
from backend.app.services.lifecycle.awaiting import clear_job_plate
from backend.app.services.lifecycle.engine import transition_queue_item, writer
from backend.app.services.lifecycle.printing import observe_print
from backend.app.services.print_scheduler import PrintScheduler, scheduler
from backend.app.services.printer_manager import printer_manager
from backend.app.services.queue_actions import cancel_job
from backend.tests.unit.test_queue_archive_alignment import alignment, hold_and_link  # noqa: F401


@pytest.mark.parametrize("status", ["dispatching", "printing"])
@pytest.mark.parametrize("outcome", ["commit", "ftp_failure", "reconnected"])
async def test_clear_plate_cleans_sent_upload_after_offline_stop(alignment, monkeypatch, status, outcome):
    from backend.app.core import tasks

    pending = []
    monkeypatch.setattr(tasks, "spawn_background_task", lambda coro, **kwargs: pending.append(coro))
    live = SimpleNamespace(connected=False, state="IDLE", job_telemetry_ready=False)
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(printer_manager, "stop_print", lambda _id: False)
    monkeypatch.setattr(scheduler.workers, "cancel", lambda _id: False)
    notified, powered_off = AsyncMock(), AsyncMock()
    deleted = AsyncMock(side_effect=OSError("offline") if outcome == "ftp_failure" else None, return_value=True)
    monkeypatch.setattr(queue_outcome_effects.notification_service, "on_queue_job_failed", notified)
    monkeypatch.setattr(queue_outcome_effects.smart_plug_manager, "schedule_off_after_queue_job", powered_off)
    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", deleted)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                job,
                "dispatching",
                status,
                values={"dispatch_subtask_id": "123", "dispatched_at": datetime.now(timezone.utc)},
            )
        job.auto_off_after = True
        await db.commit()
        for started in pending:  # Entering printing publishes its start; this test is about Stop.
            started.close()
        pending.clear()
        attempt = await db.get(PrintArchive, job.archive_id)
        remote_filename = attempt.extra_data["remote_filename"]
        await cancel_job(db, job)
        assert job.status == "cancelled" and job.dispatched_at is not None
        assert "Stop command not sent" in job.error_message
    assert len(pending) == 1
    await pending.pop()
    powered_off.assert_not_awaited()  # Stop intent is not proof that the printer ended the job.
    deleted.assert_not_awaited()  # The sent file is retained until the operator clears the plate.
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await clear_job_plate(db, job)
    assert len(pending) == 1
    if outcome == "reconnected":
        live.connected = live.job_telemetry_ready = True
        live.state = "RUNNING"
    await pending.pop()
    if outcome in ("commit", "ftp_failure"):
        deleted.assert_awaited_once()
        assert deleted.call_args.args[2] == f"/{remote_filename}"
    else:
        deleted.assert_not_awaited()
    powered_off.assert_not_awaited()  # An unconfirmed Stop never authorizes Auto Off.
    notified.assert_not_awaited()
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        assert job.status == "unsuccessful"


@pytest.mark.parametrize("failing_step", ["notification_source", "notification_log", "notification_status", "heaters"])
async def test_database_failure_in_one_effect_does_not_skip_later_cleanup(alignment, monkeypatch, failing_step):
    from backend.app.core import tasks

    committed = []
    monkeypatch.setattr(tasks, "spawn_background_task", lambda coro, **kwargs: committed.append(coro))
    client = MagicMock()
    state = SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True, preheating=True)
    monkeypatch.setattr(printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: state)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "_broadcast_status_change", AsyncMock())
    if failing_step == "heaters":
        # The durable shutdown clears only after fresh zero-target telemetry;
        # make that write the injected database failure.
        monkeypatch.setattr(heat, "_reported", lambda *_args: True)
    # Exercise the real notification service's status/log commits; replace
    # only network delivery, then fail the SQL statement under review.
    monkeypatch.setattr(
        queue_outcome_effects.notification_service, "_send_to_provider", AsyncMock(return_value=(True, ""))
    )
    deleted = AsyncMock(return_value=True)
    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", deleted)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        if failing_step == "notification_source":
            async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
                await transition_queue_item(db, job, "queued", "dispatching")
        else:
            await hold_and_link(db, job)
        job.auto_off_after = True
        job.preheat_requested_at = heat.utcnow()
        db.add(NotificationProvider(name="Test", provider_type="ntfy", config="{}", on_queue_job_failed=True))
        await db.commit()
        attempt = await db.get(PrintArchive, job.archive_id) if job.archive_id else None
        remote_name = attempt.extra_data["remote_filename"] if attempt else None
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(db, job, "dispatching", "failed", action="dispatch_failure")
        await db.commit()
    assert len(committed) == 1
    engine = alignment.sessions.kw["bind"]
    failures = []

    def fail_statement(connection, cursor, statement, parameters, context, executemany):
        sql = statement.lstrip().upper()
        prefixes = {
            "notification_log": "INSERT INTO NOTIFICATION_LOGS",
            "notification_status": "UPDATE NOTIFICATION_PROVIDERS",
            "heaters": "UPDATE PRINTERS",
        }
        if (failing_step == "notification_source" and "FROM LIBRARY_FILES" in sql) or (
            failing_step in prefixes and sql.startswith(prefixes[failing_step])
        ):
            failures.append(statement)
            raise OperationalError(statement, parameters, Exception("database is locked"))

    event.listen(engine.sync_engine, "before_cursor_execute", fail_statement)
    try:
        await committed[0]
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", fail_statement)
    assert failures
    if remote_name:
        deleted.assert_awaited_once()
        assert deleted.call_args.args[2] == f"/{remote_name}"
    else:
        deleted.assert_not_awaited()
    assert client.set_bed_temperature.call_count == 1
    async with alignment.sessions() as db:
        assert (await db.get(PrintQueueItem, alignment.job_id)).status == "failed"
        assert (await db.get(Printer, 1)).heat_soak_shutdown_pending


@pytest.mark.parametrize("commit", [False, True])
@pytest.mark.parametrize("heater_fails", [False, True])
async def test_failed_dispatch_effects_run_only_after_commit(alignment, monkeypatch, commit, heater_fails):
    client = MagicMock()
    state = SimpleNamespace(preheating=True, connected=True, job_telemetry_ready=True, state="IDLE")
    monkeypatch.setattr(printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: state)
    monkeypatch.setattr(printer_manager, "_broadcast_status_change", AsyncMock())
    notified = AsyncMock()
    powered_off = AsyncMock()
    deleted = AsyncMock(return_value=True)
    done = asyncio.Event()

    async def delete_and_signal(*args, **kwargs):
        await deleted(*args, **kwargs)
        done.set()
        return True

    monkeypatch.setattr(queue_outcome_effects.notification_service, "on_queue_job_failed", notified)
    monkeypatch.setattr(queue_outcome_effects.smart_plug_manager, "schedule_off_after_queue_job", powered_off)
    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", delete_and_signal)
    if heater_fails:
        client.set_bed_temperature.side_effect = RuntimeError("heater unavailable")
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        job.auto_off_after = True
        job.preheat_requested_at = datetime.now(timezone.utc)
        await db.commit()
        archive = await db.get(PrintArchive, job.archive_id)
        remote_name = archive.extra_data["remote_filename"]
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                job,
                "dispatching",
                "failed",
                action="dispatch_failure",
                values={"error_message": "Upload failed"},
            )
        notified.assert_not_awaited()
        powered_off.assert_not_awaited()
        deleted.assert_not_awaited()
        if commit:
            await db.commit()
        else:
            await db.rollback()

    async with alignment.sessions() as observer:
        printer = await observer.get(Printer, 1)
        assert printer.heat_soak_shutdown_pending is commit
        assert (printer.heat_soak_shutdown_at is not None) is commit
    if commit:
        await asyncio.wait_for(done.wait(), 2)
        notified.assert_awaited_once()
        assert notified.call_args.kwargs["reason"] == "Upload failed"
        powered_off.assert_not_awaited()  # An unsent dispatch failure is not a physical job end.
        deleted.assert_awaited_once()
        assert deleted.call_args.args[2] == f"/{remote_name}"
        client.set_bed_temperature.assert_called_once_with(0)
        assert state.preheating is False
    else:
        await asyncio.sleep(0)
        notified.assert_not_awaited()
        powered_off.assert_not_awaited()
        deleted.assert_not_awaited()
        client.set_bed_temperature.assert_not_called()


async def test_delayed_failure_cannot_shut_down_a_new_external_print(alignment, monkeypatch):
    entered, resume = asyncio.Event(), asyncio.Event()

    async def slow_notification(**kwargs):
        entered.set()
        await resume.wait()

    monkeypatch.setattr(queue_outcome_effects.notification_service, "on_queue_job_failed", slow_notification)
    client = MagicMock()
    live = SimpleNamespace(
        state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="new-run", preheating=False
    )
    monkeypatch.setattr(printer_manager, "get_client", lambda _id: client)
    monkeypatch.setattr(printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(printer_manager, "is_connected", lambda _id: True)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        job.preheat_requested_at = heat.utcnow()
        await db.commit()
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                job,
                "dispatching",
                "failed",
                action="dispatch_failure",
                values={"error_message": "Failed before send"},
            )
        await db.commit()
    await asyncio.wait_for(entered.wait(), 2)
    try:
        async with alignment.sessions() as db:
            new_job, _ = await observe_print(db, 1, "new-run", observed_state=live)
            assert new_job is not None
            await db.commit()
            assert (await db.get(PrintQueueItem, alignment.job_id)).status == "failed"
    finally:
        resume.set()
    from backend.app.core.tasks import _background_tasks

    await asyncio.gather(*(t for t in tuple(_background_tasks) if "-effects-" in t.get_name()))
    client.set_bed_temperature.assert_not_called()
    client.set_chamber_temperature.assert_not_called()
    async with alignment.sessions() as db:
        assert (await db.get(Printer, 1)).heat_soak_shutdown_pending


async def test_cancelled_job_skips_failure_notice_and_sd_cleanup(alignment, monkeypatch):
    notified = AsyncMock()
    deleted = AsyncMock()
    powered_off = AsyncMock()
    done = asyncio.Event()

    async def power_and_signal(*args, **kwargs):
        await powered_off(*args, **kwargs)
        done.set()

    monkeypatch.setattr(queue_outcome_effects.notification_service, "on_queue_job_failed", notified)
    monkeypatch.setattr(queue_outcome_effects.smart_plug_manager, "schedule_off_after_queue_job", power_and_signal)
    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", deleted)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        async with writer(job.printer_id):
            await transition_queue_item(
                db,
                job,
                "dispatching",
                "dispatching",
                values={"dispatched_at": datetime.now(timezone.utc), "dispatch_subtask_id": "123"},
            )
        job.auto_off_after = True
        await db.commit()
        async with writer(getattr(job, "printer_id", None) or getattr(job, "assigned_printer_id", None)):
            await transition_queue_item(
                db,
                job,
                "dispatching",
                "cancelled",
                action="printer_report",
                values={"error_message": "Stop confirmed"},
            )
        await db.commit()
    await asyncio.wait_for(done.wait(), 2)
    powered_off.assert_awaited_once()
    notified.assert_not_awaited()
    deleted.assert_not_awaited()


async def test_incompatible_uploaded_dispatch_cleans_up_only_after_failure_commit(alignment, monkeypatch):
    from backend.app.services.lifecycle import dispatching as dispatch_stages

    deleted = AsyncMock(return_value=True)
    done = asyncio.Event()
    upload = AsyncMock(return_value=True)

    async def delete_and_signal(*args, **kwargs):
        async with alignment.sessions() as observer:
            parent = await observer.get(PrintQueueItem, alignment.job_id)
            assert parent.status == "failed"
        await deleted(*args, **kwargs)
        done.set()
        return True

    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", delete_and_signal)
    monkeypatch.setattr(dispatch_stages, "delete_file_async", AsyncMock(return_value=True))
    monkeypatch.setattr(dispatch_stages, "upload_file_async", upload)
    monkeypatch.setattr(dispatch_stages, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1.0)))
    monkeypatch.setattr(dispatch_stages.Dispatcher, "_telemetry", lambda *_args: True)
    monkeypatch.setattr(
        printer_manager,
        "get_status",
        lambda _id: SimpleNamespace(state="IDLE", connected=True, job_telemetry_ready=True, raw_data={}),
    )
    monkeypatch.setattr(dispatch_stages, "_incompatible_sliced_model_reason", lambda *_args: "Wrong printer model")
    monkeypatch.setattr(queue_outcome_effects.notification_service, "on_queue_job_failed", AsyncMock())
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        async with writer(job.printer_id):
            await transition_queue_item(
                db,
                job,
                "dispatching",
                "dispatching",
                values={"dispatch_stage": "uploading"},
            )
        archive = await db.get(PrintArchive, job.archive_id)
        archive.sliced_for_model = "A1"
        remote_path = f"/{archive.extra_data['remote_filename']}"
        await db.commit()
        await PrintScheduler().dispatcher._upload_stage(job.id)
        await asyncio.wait_for(done.wait(), 2)
        await db.refresh(job)
        assert job.status == "failed"
        assert job.physical_outcome is None
        retry = await db.scalar(select(PrintQueueItem).where(PrintQueueItem.id != job.id))
        assert retry is not None and retry.status == "queued" and retry.retry_on_failure is False
    upload.assert_awaited_once()
    deleted.assert_awaited_once()
    assert deleted.call_args.args[2] == remote_path
