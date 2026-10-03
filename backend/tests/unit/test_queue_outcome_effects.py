"""Committed queue outcomes own notification, power, heaters, and SD cleanup."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services import print_scheduler, queue_outcome_effects
from backend.app.services.printer_manager import printer_manager
from backend.app.services.queue_transitions import transition_queue_item
from backend.tests.unit.test_queue_archive_alignment import alignment, hold_and_link  # noqa: F401


@pytest.mark.parametrize("commit", [False, True])
@pytest.mark.parametrize("heater_fails", [False, True])
async def test_failed_dispatch_effects_run_only_after_commit(alignment, monkeypatch, commit, heater_fails):
    client = MagicMock()
    state = SimpleNamespace(preheating=True)
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
    heater = MagicMock(side_effect=RuntimeError("heater unavailable")) if heater_fails else None
    if heater is not None:
        monkeypatch.setattr(queue_outcome_effects, "_heaters_off", heater)
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        job.auto_off_after = True
        job.preheat_requested_at = datetime.now(timezone.utc)
        await db.commit()
        archive = await db.get(PrintArchive, job.archive_id)
        remote_name = archive.extra_data["remote_filename"]
        await transition_queue_item(db, job, "dispatching", "failed", values={"error_message": "Upload failed"})
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
        powered_off.assert_awaited_once()
        deleted.assert_awaited_once()
        assert deleted.call_args.args[2] == f"/{remote_name}"
        if heater is not None:
            heater.assert_called_once()
        else:
            client.set_bed_temperature.assert_called_once_with(0)
        assert state.preheating is False
    else:
        await asyncio.sleep(0)
        notified.assert_not_awaited()
        powered_off.assert_not_awaited()
        deleted.assert_not_awaited()
        if heater is not None:
            heater.assert_not_called()
        else:
            client.set_bed_temperature.assert_not_called()


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
        job.auto_off_after = True
        await db.commit()
        await transition_queue_item(db, job, "dispatching", "cancelled", values={"error_message": "Stop requested"})
        await db.commit()
    await asyncio.wait_for(done.wait(), 2)
    powered_off.assert_awaited_once()
    notified.assert_not_awaited()
    deleted.assert_not_awaited()


async def test_incompatible_uploaded_dispatch_uses_only_committed_cleanup(alignment, monkeypatch):
    deleted = AsyncMock(return_value=True)
    inline_delete = AsyncMock()
    done = asyncio.Event()

    async def delete_and_signal(*args, **kwargs):
        await deleted(*args, **kwargs)
        done.set()
        return True

    monkeypatch.setattr(queue_outcome_effects, "delete_file_async", delete_and_signal)
    monkeypatch.setattr(print_scheduler, "delete_file_async", inline_delete)
    monkeypatch.setattr(queue_outcome_effects.notification_service, "on_queue_job_failed", AsyncMock())
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, job)
        await db.commit()
        printer = await db.get(Printer, job.printer_id)
        archive = await db.get(PrintArchive, job.archive_id)
        remote_path = f"/{archive.extra_data['remote_filename']}"
        assert await print_scheduler._defer_incompatible_dispatch(db, job, printer, "A1", remote_path=remote_path)
        assert job.status == "failed"
    await asyncio.wait_for(done.wait(), 2)
    deleted.assert_awaited_once()
    assert deleted.call_args.args[2] == remote_path
    inline_delete.assert_not_awaited()
