"""Effects emitted after Queue outcomes and failed-attempt plate clearing commit."""

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.bambu_ftp import delete_file_async
from backend.app.services.chamber_heat_soak import _show_preheating, cleanup_heat_soak_shutdown
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

    if effect.shut_down_heaters:
        try:
            async with sessions() as db:
                if effect.printer_id is not None and await cleanup_heat_soak_shutdown(db, effect.printer_id):
                    _show_preheating(effect.printer_id, False)
        except Exception:
            logger.exception("Queue job %s: heater shutdown failed", effect.job_id)

    if effect.clean_sd_copy and remote_filename and connection is not None:
        if effect.new_state == "unsuccessful":
            from backend.app.services.printer_manager import printer_manager

            live = printer_manager.get_status(effect.printer_id)
            if (
                live
                and live.connected
                and getattr(live, "job_telemetry_ready", True)
                and live.state in ("PREPARE", "SLICING", "RUNNING", "PAUSE")
            ):
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
