"""Copy a held dispatch's source into its own immutable Archive."""

import errno
import json
import logging
import shutil
from collections.abc import Sequence
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import AWAITING_PLATE_CLEAR_STATUSES, FINAL_STATUSES, PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.archive import ArchiveService
from backend.app.services.lifecycle import effects
from backend.app.services.lifecycle.engine import ARCHIVE_OUTCOMES, physical_failure_reason
from backend.app.utils.filename import derive_queue_remote_filename
from backend.app.utils.safe_path import safe_join_under
from backend.app.utils.threemf_tools import inject_gcode_into_3mf

if TYPE_CHECKING:
    from backend.app.services.lifecycle.engine import Transition

logger = logging.getLogger(__name__)


async def align_attempt(change: "Transition") -> None:
    """Mirror a written transition onto the job's own Archive attempt."""
    db, table, item_id, status = change.db, PrintQueueItem.__table__, change.item_id, change.after
    # Only the exact attempt, never the Archive used as a reprint source.
    row = (await db.execute(select(table).where(table.c.id == item_id))).one()
    query = select(PrintArchive).where(
        PrintArchive.dispatched_queue_item_id == item_id, PrintArchive.printer_id == row.printer_id
    )
    if row.archive_id is not None:
        query = query.where(PrintArchive.id == row.archive_id)
    attempt = await db.scalar(query)
    if attempt is None:
        return
    attaching = "archive_id" in change.values or row.archive_id is None
    if row.archive_id is None:
        # The unique attempt owner survives a failed Queue-link transaction.
        # Restore that projection before applying the outcome, including
        # Stop/Clear Plate during recovery.
        await db.execute(table.update().where(table.c.id == item_id).values(archive_id=attempt.id))
        if not isinstance(change.item, int):
            set_committed_value(change.item, "archive_id", attempt.id)
            set_committed_value(change.item, "archive", attempt)
    if status == "dispatching" and "dispatch_subtask_id" in change.values:
        attempt.subtask_id = change.values["dispatch_subtask_id"]
    if (change.before == "dispatching" and status == "printing") or (attaching and status in ("printing", "paused")):
        attempt.status = "printing"
        attempt.started_at = row.started_at or datetime.now(timezone.utc)
    recorded = status in AWAITING_PLATE_CLEAR_STATUSES and (
        change.before != status or change.action == "printer_report"
    )
    if recorded or (attaching and status in (*AWAITING_PLATE_CLEAR_STATUSES, *FINAL_STATUSES)):
        outcome = row.physical_outcome or ARCHIVE_OUTCOMES.get(status)
        if outcome is None and status == "successful":
            outcome = "completed"  # Unambiguous legacy final state.
        if outcome is None and status == "unsuccessful" and row.stop_requested_at is not None:
            outcome = "aborted"  # The attempt was stopped; printer confirmation remains unknown.
        if outcome is not None:
            attempt.status = outcome
            attempt.completed_at = row.physical_completed_at or row.completed_at
            attempt.failure_reason = (
                row.physical_failure_reason
                if row.physical_outcome is not None
                else physical_failure_reason(outcome, row.error_message)
            )
            if attaching and row.started_at is not None:
                attempt.started_at = row.started_at


async def link_dispatch_archive(
    db: AsyncSession,
    item: PrintQueueItem,
    archive: PrintArchive,
    *,
    conditions: Sequence[ColumnElement[bool]] = (),
) -> None:
    """Claim the held job before flushing its copy; caller commits both together."""
    from backend.app.services.lifecycle.engine import (
        InvalidQueueTransition,
        QueueTransitionConflict,
        transition_queue_item,
    )

    if (
        item.status != "dispatching"
        or archive not in db
        or not inspect(archive).pending
        or archive.dispatched_queue_item_id != item.id
        or archive.printer_id != item.printer_id
        or archive.status != "dispatching"
        or archive.deleted_at is not None
        or not archive.file_path
    ):
        raise InvalidQueueTransition("Dispatch Archive does not belong to this held job")
    try:
        await transition_queue_item(db, item, "dispatching", "dispatching", conditions=conditions)
    except QueueTransitionConflict:
        discard_prepared_archive(db, archive)
        raise
    await db.flush([archive])
    await transition_queue_item(
        db,
        item,
        "dispatching",
        "dispatching",
        values={"archive_id": archive.id},
        conditions=conditions,
        action="archive_link",
    )
    set_committed_value(item, "archive", archive)


class DispatchSourceUnavailable(RuntimeError):
    """The dispatch source row is missing or soft-deleted."""


class DispatchPreparationError(RuntimeError):
    """A preparation failure with a message safe to show to users."""


def dispatch_copy_error(error: Exception) -> str:
    """Return a useful failure without exposing server paths or parser details."""
    message = "Failed to create Archive record for dispatch"
    if isinstance(error, (DispatchSourceUnavailable, DispatchPreparationError)):
        message += f": {error}"
    elif isinstance(error, OSError):
        cause = (
            "Not enough disk space to copy the print file"
            if error.errno == errno.ENOSPC
            else "Could not copy the print file"
        )
        message += f": {cause}"
    return message


def discard_prepared_archive(
    db: AsyncSession, archive: PrintArchive | None, directories: list[Path] | None = None
) -> None:
    """Discard only this preparation; other pending attempts retain their files."""
    if directories is None:
        directories = inspect(archive).info.pop("queue_prepared_dirs", []) if archive is not None else []
    if archive is not None and archive in db:
        db.expunge(archive)
    for directory in directories:
        shutil.rmtree(directory, ignore_errors=True)


async def prepare_dispatch_archive(db: AsyncSession, item: PrintQueueItem) -> PrintArchive:
    """Copy after the hold commits; leave the new row unflushed until linking."""
    from backend.app.api.routes.settings import get_setting

    # The prepared row must not flush before the guarded link wins.
    with db.no_autoflush:
        source = await db.get(PrintArchive, item.archive_id, populate_existing=True) if item.archive_id else None
        if source is None and item.library_file_id:
            source = await db.get(LibraryFile, item.library_file_id, populate_existing=True)
        if source is None:
            raise DispatchSourceUnavailable("Dispatch source no longer exists")
        if source.deleted_at is not None:
            raise DispatchSourceUnavailable("Dispatch source was deleted")
        printer_id = item.printer_id
        printer = await db.get(Printer, printer_id)
        if printer is None:
            raise DispatchPreparationError("Dispatch printer no longer exists")
        source_path = Path(source.file_path)
        source_path = (
            source_path
            if source_path.is_absolute()
            else safe_join_under(settings.base_dir, str(source_path), http=False)
        )
        remote_filename = derive_queue_remote_filename(source.filename)
        start_gc = end_gc = None
        if item.gcode_injection:
            snippets_raw = await get_setting(db, "gcode_snippets")
            if snippets_raw:
                try:
                    snippets = json.loads(snippets_raw).get(printer.model, {})
                    start_gc = (snippets.get("start_gcode") or "").strip() or None
                    end_gc = (snippets.get("end_gcode") or "").strip() or None
                except (ValueError, AttributeError, TypeError):
                    logger.warning("Queue item %s: invalid G-code snippets", item.id)
        injected_path = None
        archive = None
        created_dirs = []
        try:
            # Remove previous Grove blocks even when injection is disabled.
            injected_path = inject_gcode_into_3mf(source_path, item.plate_id or 1, start_gc, end_gc)
            if injected_path is None and (start_gc or end_gc):
                logger.warning("Queue item %s: G-code injection returned no result, using original", item.id)
            archive = await ArchiveService(db).archive_print(
                printer_id=printer_id,
                source_file=injected_path or source_path,
                original_filename=source.filename,
                print_data={"status": "dispatching", "source": "queue_dispatch", "source_archive_id": item.archive_id},
                created_by_id=item.created_by_id,
                project_id=item.project_id or getattr(source, "project_id", None),
                dispatched_queue_item_id=item.id,
                commit=False,
                flush=False,
                unique_dir=True,
                created_dirs=created_dirs,
            )
            if archive is None:
                raise DispatchPreparationError("ArchiveService did not create an attempt record")
            archive.extra_data = {
                **(archive.extra_data or {}),
                "remote_filename": remote_filename,
                "source_archive_id": item.archive_id,
            }
            inspect(archive).info["queue_prepared_dirs"] = created_dirs
            for directory in created_dirs:
                effects.on_rollback(db, partial(shutil.rmtree, directory, ignore_errors=True))
            return archive
        except BaseException:
            discard_prepared_archive(db, archive, created_dirs)
            raise
        finally:
            if injected_path:
                try:
                    injected_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Queue item %s: could not remove temporary G-code copy %s", item.id, injected_path)
