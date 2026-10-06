"""After-commit effects of the print job lifecycle (#204).

Effects queued in the caller's transaction run, in order, once it commits. If
it ends any other way (rollback, failed commit, closed session) they are
discarded and the undo steps run instead. A key replaces an earlier effect in
its original position. Each callback runs once; a failing one is logged and
never undoes or misreports the commit, nor skips the others. Work is queued
only in the outermost transaction: a savepoint can be released or rolled back
on its own, so it neither runs nor discards the outer transaction's work.
Effects must not queue further effects; those would be dropped unrun.
"""

import logging
from collections.abc import Callable, Hashable
from dataclasses import dataclass

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import Session

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services import job_identity
from backend.app.services.bambu_ftp import delete_file_async
from backend.app.services.notification_service import notification_service
from backend.app.services.smart_plug_manager import smart_plug_manager

logger = logging.getLogger(__name__)
_COMMIT, _UNDO = "lifecycle_after_commit", "lifecycle_undo"


def after_commit(db: AsyncSession, effect: Callable[[], object], *, key: Hashable | None = None) -> None:
    _outermost(db).info.setdefault(_COMMIT, {})[object() if key is None else key] = effect


def on_rollback(db: AsyncSession, undo: Callable[[], object]) -> None:
    _outermost(db).info.setdefault(_UNDO, []).append(undo)


def _outermost(db: AsyncSession) -> Session:
    if db.in_nested_transaction():
        raise RuntimeError("Lifecycle effects cannot be queued inside a savepoint")
    if not db.in_transaction():
        db.sync_session.begin()  # Otherwise the work could leak into a later transaction.
    return db.sync_session


def _run(callbacks, kind: str) -> None:
    for callback in callbacks:
        try:
            callback()
        except Exception:
            logger.exception("Lifecycle %s failed: %r", kind, callback)


@event.listens_for(Session, "after_commit")
def _run_effects(session: Session) -> None:
    # SQLAlchemy also dispatches this when a savepoint is released.
    if not session.in_nested_transaction():
        session.info.pop(_UNDO, None)
        _run(session.info.pop(_COMMIT, {}).values(), "effect")


@event.listens_for(Session, "after_transaction_end")
def _discard_uncommitted(session: Session, transaction) -> None:
    # Rollback, a failed commit and Session.close() all end the outermost
    # transaction here. A commit has already taken its pending work above.
    if transaction.parent is None:
        session.info.pop(_COMMIT, None)
        _run(session.info.pop(_UNDO, []), "undo step")


def publish_printer_view(db: AsyncSession, printer_id: int, status: str, archive_id: int | None) -> None:
    """Show the committed holding state in the printer's plate-clear view."""

    def publish() -> None:
        from backend.app.services.printer_manager import printer_manager

        awaiting = status in AWAITING_PLATE_CLEAR_STATUSES
        printer_manager.set_awaiting_plate_clear(printer_id, awaiting)
        printer_manager.set_awaiting_plate_clear_archive_id(printer_id, archive_id if awaiting else None)

    after_commit(db, publish, key=("printer_view", printer_id))


def shut_down_heaters(db: AsyncSession, printer_id: int) -> None:
    """Retry the printer's recorded heater shutdown once this transaction commits."""
    engine = db.bind

    def spawn() -> None:
        from backend.app.core.tasks import spawn_background_task

        spawn_background_task(_shut_down_heaters(engine, printer_id), name=f"queue-heater-effects-{printer_id}")

    after_commit(db, spawn, key=("heaters", printer_id))


async def _shut_down_heaters(engine: AsyncEngine, printer_id: int) -> None:
    from backend.app.services.lifecycle.preheating import _show_preheating, cleanup_heat_soak_shutdown

    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            if await cleanup_heat_soak_shutdown(db, printer_id):
                _show_preheating(printer_id, False)
    except Exception:
        logger.exception("Printer %s: heater shutdown failed", printer_id)


@dataclass(frozen=True)
class QueueOutcomeEffect:
    job_id: int
    new_state: str
    printer_id: int | None
    shut_down_heaters: bool = False
    notify_failure: bool = False
    clean_sd_copy: bool = False


def queue_outcome_effect(db: AsyncSession, effect: QueueOutcomeEffect) -> None:
    engine = db.bind

    def spawn() -> None:
        from backend.app.core.tasks import spawn_background_task

        name = f"queue-{effect.new_state}-effects-{effect.job_id}"
        spawn_background_task(run_queue_outcome_effects(engine, effect), name=name)

    after_commit(db, spawn, key=("outcome", effect.job_id, effect.new_state))


async def run_queue_outcome_effects(engine: AsyncEngine, effect: QueueOutcomeEffect) -> None:
    """Use committed data and let each best-effort effect fail independently."""
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        job = await db.get(PrintQueueItem, effect.job_id)
        if job is None or job.status not in (effect.new_state, "unsuccessful"):
            return
        printer = await db.get(Printer, effect.printer_id) if effect.printer_id is not None else None
        archive = await db.get(PrintArchive, job.archive_id) if job.archive_id is not None else None
        attempt = archive if archive and archive.dispatched_queue_item_id == job.id else None
        remote_filename = (attempt.extra_data or {}).get("remote_filename") if attempt else None
        connection = (printer.ip_address, printer.access_code, printer.model) if printer else None
        auto_off = bool(job.auto_off_after)
        filename = archive.filename if archive else None
        library_file_id = job.library_file_id
        printer_name = printer.name if printer else None
        reason = job.error_message or "Print failed"

    # Keep only scalar inputs after the read session closes. A failed flush in
    # one effect expires ORM rows and poisons its session, never the next effect.
    if effect.notify_failure:
        try:
            async with sessions() as db:
                if filename is None and library_file_id is not None:
                    source = await db.get(LibraryFile, library_file_id)
                    filename = source.filename if source else None
                job_name = (filename or f"Job #{effect.job_id}").replace(".gcode.3mf", "").replace(".3mf", "")
                await notification_service.on_queue_job_failed(
                    job_name=job_name,
                    printer_id=effect.printer_id,
                    printer_name=printer_name,
                    reason=reason,
                    db=db,
                )
        except Exception:
            logger.exception("Queue job %s: failure notification failed", effect.job_id)

    if auto_off and effect.new_state in ("failed", "cancelled") and effect.printer_id is not None:
        try:
            async with sessions() as db:
                await smart_plug_manager.schedule_off_after_queue_job(effect.printer_id, db)
        except Exception:
            logger.exception("Queue job %s: auto power-off scheduling failed", effect.job_id)

    if effect.shut_down_heaters and effect.printer_id is not None:
        await _shut_down_heaters(engine, effect.printer_id)

    if effect.clean_sd_copy and remote_filename and connection is not None:
        if effect.new_state == "unsuccessful" and job_identity.printer_active(effect.printer_id):
            logger.info("Queue job %s: skipping plate-clear SD cleanup while printer is active", effect.job_id)
            return  # A reconnect or new start overtook Clear Plate.
        try:
            await delete_file_async(
                connection[0],
                connection[1],
                f"/{remote_filename}",
                printer_model=connection[2],
            )
        except Exception:
            logger.exception("Queue job %s: failed to remove SD dispatch copy", effect.job_id)
