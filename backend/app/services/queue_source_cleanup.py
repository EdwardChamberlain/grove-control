"""Cleanup for temporary File rows used only as Queue upload sources."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.utils.safe_path import safe_join_under

logger = logging.getLogger(__name__)

_SOURCE_NEEDED_STATUSES = ("pending", "preheating", "dispatching", "printing", "skipped")
_UNSEALED_SOURCE_MAX_AGE = timedelta(hours=24)
_SOURCE_SWEEP_INTERVAL_SECONDS = 60 * 60
_queue_source_cleanup_task: asyncio.Task | None = None


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
    if (
        library_file is None
        or not library_file.queue_only
        or library_file.is_external
        or not library_file.queue_source_sealed
    ):
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
            path = stored if stored.is_absolute() else safe_join_under(Path(settings.base_dir), stored_path, http=False)
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


async def sweep_stale_queue_sources(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Seal old intake sources and delete those no longer needed by queue items.

    Direct upload clients normally seal the source when their submission flow
    closes. This sweep is the crash/network-failure backstop: after 24 hours,
    the remaining request fan-out window is presumed closed. The regular
    cleanup helper still preserves sources referenced by active or retryable
    queue items.
    """
    now = now or datetime.now(timezone.utc)
    stale_before = now - _UNSEALED_SOURCE_MAX_AGE
    stale_ids = (
        (
            await db.execute(
                select(LibraryFile.id)
                .where(
                    LibraryFile.queue_only.is_(True),
                    LibraryFile.queue_source_sealed.is_(False),
                    LibraryFile.created_at <= stale_before,
                )
                .order_by(LibraryFile.created_at, LibraryFile.id)
            )
        )
        .scalars()
        .all()
    )
    if not stale_ids:
        return 0

    paths: list[Path] = []
    sealed_count = 0
    for library_file_id in stale_ids:
        result = await db.execute(
            select(LibraryFile)
            .where(
                LibraryFile.id == library_file_id,
                LibraryFile.queue_only.is_(True),
                LibraryFile.queue_source_sealed.is_(False),
                LibraryFile.created_at <= stale_before,
            )
            .with_for_update()
        )
        library_file = result.scalar_one_or_none()
        if library_file is None:
            continue

        library_file.queue_source_sealed = True
        sealed_count += 1
        await db.flush()
        paths.extend(await remove_queue_only_source_if_unused(db, library_file_id))

    await db.commit()
    remove_queue_only_artifacts(paths)
    if sealed_count:
        logger.info(
            "Sealed %d stale Queue-only source(s) and removed %d source artifact(s)",
            sealed_count,
            len(paths),
        )
    return sealed_count


async def _sweep_stale_queue_sources_once() -> int:
    from backend.app.core.database import async_session

    async with async_session() as db:
        return await sweep_stale_queue_sources(db)


async def _queue_source_cleanup_loop() -> None:
    """Run an immediate stale-source sweep, then repeat hourly."""
    while True:
        try:
            await _sweep_stale_queue_sources_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Stale Queue-only source cleanup failed")
        await asyncio.sleep(_SOURCE_SWEEP_INTERVAL_SECONDS)


def start_queue_source_cleanup() -> None:
    global _queue_source_cleanup_task
    if _queue_source_cleanup_task is None:
        _queue_source_cleanup_task = asyncio.create_task(_queue_source_cleanup_loop())
        logger.info("Stale Queue-only source cleanup started")


def stop_queue_source_cleanup() -> None:
    global _queue_source_cleanup_task
    if _queue_source_cleanup_task is not None:
        _queue_source_cleanup_task.cancel()
        _queue_source_cleanup_task = None
        logger.info("Stale Queue-only source cleanup stopped")
