"""Prepare the immutable artifact committed with entry into dispatching."""

import json
import logging
import shutil
from pathlib import Path

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.archive import ArchiveService
from backend.app.utils.filename import derive_queue_remote_filename
from backend.app.utils.safe_path import safe_join_under
from backend.app.utils.threemf_tools import inject_gcode_into_3mf

logger = logging.getLogger(__name__)


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
    artifacts = db.sync_session.info.get("queue_archive_artifacts", [])
    artifacts[:] = [directory for directory in artifacts if directory not in directories]


async def prepare_dispatch_archive(db: AsyncSession, item: PrintQueueItem, values: dict) -> PrintArchive | None:
    """Copy without flushing, so cancellation can win during preparation.

    The transition writer adds the exact link only after its conditional update
    succeeds. Synthetic/source-less legacy jobs have no artifact to copy.
    """
    from backend.app.api.routes.settings import get_setting

    # Tentative scheduler bindings and the prepared row must not flush before CAS.
    with db.no_autoflush:
        source = await db.get(PrintArchive, item.archive_id) if item.archive_id else None
        if source is None and item.library_file_id:
            source = await db.get(LibraryFile, item.library_file_id)
        if source is None:
            if item.archive_id or item.library_file_id:
                raise RuntimeError("Dispatch source no longer exists")
            return None
        if source.deleted_at is not None:
            raise RuntimeError("Dispatch source was deleted")
        printer_id = values.get("printer_id", item.printer_id)
        printer = await db.get(Printer, printer_id)
        if printer is None:
            raise RuntimeError("Dispatch printer no longer exists")
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
                raise RuntimeError("ArchiveService did not create an attempt record")
            archive.extra_data = {
                **(archive.extra_data or {}),
                "remote_filename": remote_filename,
                "source_archive_id": item.archive_id,
            }
            inspect(archive).info["queue_prepared_dirs"] = created_dirs
            db.sync_session.info.setdefault("queue_archive_artifacts", []).extend(created_dirs)
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
