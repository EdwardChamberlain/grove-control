"""Service for writing independent print log entries.

Log entries are written to a separate table and never touch archives or queue items.
"""

import logging
from datetime import datetime

from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)


async def write_log_entry(
    db: AsyncSession,
    *,
    status: str,
    archive_id: int | None = None,
    queue_item_id: int | None = None,
    print_name: str | None = None,
    printer_name: str | None = None,
    printer_id: int | None = None,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
    filament_type: str | None = None,
    filament_color: str | None = None,
    filament_used_grams: float | None = None,
    cost: float | None = None,
    energy_kwh: float | None = None,
    energy_cost: float | None = None,
    failure_reason: str | None = None,
    thumbnail_path: str | None = None,
    created_by_id: int | None = None,
    created_by_username: str | None = None,
) -> PrintLogEntry:
    """Write a print log entry."""
    duration = None
    if started_at and completed_at:
        duration = int((completed_at - started_at).total_seconds())

    entry = PrintLogEntry(
        archive_id=archive_id,
        queue_item_id=queue_item_id,
        print_name=print_name,
        printer_name=printer_name,
        printer_id=printer_id,
        status=status,
        started_at=started_at,
        completed_at=completed_at,
        duration_seconds=duration,
        filament_type=filament_type,
        filament_color=filament_color,
        filament_used_grams=filament_used_grams,
        cost=cost,
        energy_kwh=energy_kwh,
        energy_cost=energy_cost,
        failure_reason=failure_reason,
        thumbnail_path=thumbnail_path,
        created_by_id=created_by_id,
        created_by_username=created_by_username,
    )
    db.add(entry)
    await db.flush()
    return entry


async def increment_print_job_count(db: AsyncSession, printer_id: int) -> None:
    """Add one finished job to a printer's lifetime job counter and commit.

    The counter drives the "print jobs" maintenance interval type (#337). It is
    deliberately separate from the print log: a job still counts when no archive
    (and therefore no log row) exists, and clearing the log never resets it.
    The update is a single atomic SQL increment, so concurrent completions on
    different printers (or a reconnect race on one) cannot lose a count.
    """
    await db.execute(
        update(Printer)
        .where(Printer.id == printer_id)
        .values(print_job_count=func.coalesce(Printer.print_job_count, 0) + 1)
    )
    await db.commit()
