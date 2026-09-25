"""Cleanup for temporary File rows used only as Queue upload sources."""

import logging
from pathlib import Path

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.utils.safe_path import assert_under, safe_join_under

logger = logging.getLogger(__name__)

_SOURCE_NEEDED_STATUSES = ("pending", "preheating", "dispatching", "printing")


async def remove_queue_only_source_if_unused(
    db: AsyncSession,
    library_file_id: int,
    *,
    exclude_item_id: int | None = None,
) -> list[Path]:
    """Delete a Queue-only source after all queued jobs have copied it to Archive.

    Failed jobs without an Archive link keep their source available for retry.
    Historical queue rows are detached before deleting the library row so the
    FK's cascade cannot erase queue history.
    """
    library_file = await db.get(LibraryFile, library_file_id)
    if library_file is None or not library_file.queue_only or library_file.is_external:
        return []

    source_filters = [
        PrintQueueItem.library_file_id == library_file_id,
        or_(
            PrintQueueItem.status.in_(_SOURCE_NEEDED_STATUSES),
            (PrintQueueItem.status == "failed") & PrintQueueItem.archive_id.is_(None),
        ),
    ]
    if exclude_item_id is not None:
        source_filters.append(PrintQueueItem.id != exclude_item_id)
    source_still_needed = await db.scalar(select(PrintQueueItem.id).where(*source_filters).limit(1))
    if source_still_needed is not None:
        return []

    await db.execute(
        update(PrintQueueItem).where(PrintQueueItem.library_file_id == library_file_id).values(library_file_id=None)
    )

    paths: list[Path] = []
    for stored_path in (library_file.file_path, library_file.thumbnail_path):
        if stored_path:
            stored = Path(stored_path)
            path = (
                assert_under(Path(settings.base_dir), stored, http=False)
                if stored.is_absolute()
                else safe_join_under(Path(settings.base_dir), stored_path, http=False)
            )
            paths.append(path)
    await db.delete(library_file)
    return paths


def remove_queue_only_artifacts(paths: list[Path]) -> None:
    """Remove source artifacts after the database transaction commits."""
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("QUEUE_ONLY_SOURCE_ORPHAN path=%s error=%s", path, exc)
