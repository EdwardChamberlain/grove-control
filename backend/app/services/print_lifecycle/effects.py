"""Transaction-local effects, with awaited MQTT delivery preserving printer order."""

import logging
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Any, Literal

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

logger = logging.getLogger("backend.app.services.queue_transitions")


@dataclass
class CommittedEffect:
    callback: Callable
    delivery: Literal["sync", "background", "caller"]
    committed: bool = False

    async def run(self) -> Any:
        if self.committed:
            self.committed = False
            return await self.callback()


def after_commit(db: AsyncSession, key: tuple, callback: Callable, *, delivery="sync") -> CommittedEffect:
    effects = db.sync_session.info.setdefault("print_lifecycle_effects", {})
    effect = CommittedEffect(callback, delivery)
    effects[key] = effect
    return effect


def queue_start(db, job_id, publisher, *, delivery="caller") -> CommittedEffect:
    return after_commit(db, ("queue-start", job_id), partial(publisher, job_id), delivery=delivery)


@event.listens_for(Session, "after_commit")
def _run_committed_effects(session: Session) -> None:
    session.info.pop("queue_archive_artifacts", None)
    for key, effect in session.info.pop("print_lifecycle_effects", {}).items():
        effect.committed = True
        if effect.delivery == "sync":
            effect.committed = False
            effect.callback()
        elif effect.delivery == "background":
            from backend.app.core.tasks import spawn_background_task

            spawn_background_task(effect.run(), name="queue-" + "-".join(map(str, key)))


@event.listens_for(Session, "after_rollback")
def _discard_effects(session: Session) -> None:
    session.info.pop("print_lifecycle_effects", None)
    for directory in session.info.pop("queue_archive_artifacts", []):
        shutil.rmtree(directory, ignore_errors=True)


@event.listens_for(Session, "after_transaction_end")
def _discard_closed_transaction(session: Session, transaction) -> None:
    if transaction.parent is None:
        _discard_effects(session)  # Session.close() has no after_rollback event.


def log_transition(db, *record) -> None:
    sequence = len(db.sync_session.info.get("print_lifecycle_effects", {}))
    message = "Queue job %s: %s -> %s (printer=%s, archive=%s, action=%s)"
    after_commit(db, ("transition", sequence), partial(logger.info, message, *record))


def publish_printer_view(printer_id: int, status: str, archive_id: int | None) -> None:
    from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES
    from backend.app.services.printer_manager import printer_manager

    awaiting = status in AWAITING_PLATE_CLEAR_STATUSES
    printer_manager.set_awaiting_plate_clear(printer_id, awaiting)
    printer_manager.set_awaiting_plate_clear_archive_id(printer_id, archive_id if awaiting else None)


async def run_print_start(printer_id, data, job_id, archive_id, was_dispatching, recovering) -> None:
    from backend.app import main

    if was_dispatching:
        await main.print_scheduler._publish_queue_job_started(job_id)
    new_start = not recovering and main._started_job_effects.get(printer_id) != job_id
    main._started_job_effects[printer_id] = job_id
    linked_id = archive_id
    try:
        if new_start:
            await main._begin_new_print(printer_id, data)
        if data.get("filename") or data.get("subtask_name"):
            await main._archive_print_start(printer_id, data, queue_archive_id=archive_id, queue_job_id=job_id)
        linked_id = await main._link_observed_archive(printer_id, job_id, data["submission_id"])
    finally:
        if new_start:
            await main._finish_new_print(printer_id, data, linked_id)


async def run_queue_completion(printer_id, data, record) -> None:
    from sqlalchemy import func, select

    from backend.app import main
    from backend.app.models.print_queue import PrintQueueItem

    try:
        printer = main.printer_manager.get_printer(printer_id)
        await main.mqtt_relay.on_queue_job_completed(
            job_id=record.job_id,
            filename=data.get("filename", "") or data.get("subtask_name", ""),
            printer_id=printer_id,
            printer_name=printer.name if printer else "Unknown",
            status=record.queue_status,
        )
    except Exception:
        pass
    try:
        from datetime import datetime, timezone

        async with main.async_session() as db:
            pending = await db.scalar(select(func.count(PrintQueueItem.id)).where(PrintQueueItem.status == "queued"))
            if not pending:
                today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
                completed = await db.scalar(
                    select(func.count(PrintQueueItem.id)).where(
                        PrintQueueItem.status.in_(("finished", "successful", "failed", "cancelled", "unsuccessful")),
                        PrintQueueItem.completed_at >= today,
                    )
                )
                await main.notification_service.on_queue_completed(completed_count=completed or 1, db=db)
    except Exception:
        pass
    if record.auto_off and record.queue_status == "completed":
        try:
            async with main.async_session() as db:
                await main.smart_plug_manager.schedule_off_after_queue_job(printer_id, db)
        except Exception as exc:
            logger.warning("Failed to schedule queue auto-off for printer %s: %s", printer_id, exc)
