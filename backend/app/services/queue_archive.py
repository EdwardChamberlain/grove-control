"""Prepare the immutable artifact committed with entry into dispatching."""

import json
import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.archive import ArchiveService
from backend.app.utils.filename import derive_queue_remote_filename
from backend.app.utils.safe_path import safe_join_under
from backend.app.utils.threemf_tools import inject_gcode_into_3mf

logger = logging.getLogger(__name__)


async def prepare_dispatch_archive(db: AsyncSession, item: PrintQueueItem, values: dict) -> PrintArchive | None:
    """Copy without flushing, so cancellation can win during preparation.

    The transition writer adds the exact link only after its conditional update
    succeeds. Synthetic/source-less legacy jobs have no artifact to copy.
    """
    source = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
    if source is None and item.library_file_id:
        source = await db.get(LibraryFile, item.library_file_id)
    if source is None:
        if item.archive_id or item.library_file_id:
            raise RuntimeError("Dispatch source no longer exists")
        return None
    printer_id = values.get("printer_id", item.printer_id)
    printer = await db.get(Printer, printer_id)
    if printer is None:
        raise RuntimeError("Dispatch printer no longer exists")
    source_path = Path(source.file_path)
    source_path = (
        source_path if source_path.is_absolute() else safe_join_under(settings.base_dir, str(source_path), http=False)
    )
    remote_filename = derive_queue_remote_filename(source.filename)
    start_gc = end_gc = None
    if item.gcode_injection:
        snippets_raw = await db.scalar(select(Settings.value).where(Settings.key == "gcode_snippets"))
        if snippets_raw:
            try:
                snippets = json.loads(snippets_raw).get(printer.model, {})
                start_gc = (snippets.get("start_gcode") or "").strip() or None
                end_gc = (snippets.get("end_gcode") or "").strip() or None
            except (ValueError, AttributeError, TypeError):
                logger.warning("Queue item %s: invalid G-code snippets", item.id)
    injected_path = None
    try:
        # Remove previous Grove blocks even when injection is disabled.
        injected_path = inject_gcode_into_3mf(source_path, item.plate_id or 1, start_gc, end_gc)
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
        )
        if archive is None:
            raise RuntimeError("ArchiveService did not create an attempt record")
        archive.extra_data = {
            **(archive.extra_data or {}),
            "remote_filename": remote_filename,
            "source_archive_id": item.archive_id,
        }
        return archive
    finally:
        if injected_path:
            try:
                injected_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Queue item %s: could not remove temporary G-code copy %s", item.id, injected_path)
