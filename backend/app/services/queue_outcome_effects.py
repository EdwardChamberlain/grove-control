"""Effects emitted once a failed or cancelled queue transition commits."""

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.bambu_ftp import delete_file_async
from backend.app.services.chamber_heat_soak import _heaters_off, _show_preheating
from backend.app.services.notification_service import notification_service
from backend.app.services.smart_plug_manager import smart_plug_manager

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class QueueOutcomeEffect:
    job_id: int
    new_state: str
    printer_id: int | None
    shut_down_heaters: bool
    notify_failure: bool
    clean_sd_copy: bool


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

        if effect.notify_failure:
            try:
                source = archive
                if source is None and job.library_file_id is not None:
                    source = await db.get(LibraryFile, job.library_file_id)
                job_name = (
                    (source.filename if source else f"Job #{job.id}").replace(".gcode.3mf", "").replace(".3mf", "")
                )
                await notification_service.on_queue_job_failed(
                    job_name=job_name,
                    printer_id=effect.printer_id,
                    printer_name=printer.name if printer else None,
                    reason=job.error_message or "Print failed",
                    db=db,
                )
            except Exception:
                logger.exception("Queue job %s: failure notification failed", effect.job_id)

        if job.auto_off_after and effect.printer_id is not None:
            try:
                await smart_plug_manager.schedule_off_after_queue_job(effect.printer_id, db)
            except Exception:
                logger.exception("Queue job %s: auto power-off scheduling failed", effect.job_id)

        if effect.shut_down_heaters:
            try:
                if printer is not None:
                    _heaters_off(printer)
            except Exception:
                logger.exception("Queue job %s: heater shutdown failed", effect.job_id)
            try:
                if effect.printer_id is not None:
                    _show_preheating(effect.printer_id, False)
            except Exception:
                logger.exception("Queue job %s: preheating display update failed", effect.job_id)

        if effect.clean_sd_copy and remote_filename and printer is not None:
            try:
                await delete_file_async(
                    printer.ip_address,
                    printer.access_code,
                    f"/{remote_filename}",
                    printer_model=printer.model,
                )
            except Exception:
                logger.exception("Queue job %s: failed to remove SD dispatch copy", effect.job_id)
