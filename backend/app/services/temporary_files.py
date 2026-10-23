"""Temporary Files: the Grove-managed folder for system-placed uploads (#237).

Files holds what the user chose to keep. Direct uploads from a printer card
and from Queue → Add Job are not that: they exist only so a job can be
queued. Those uploads land in one system folder, Temporary Files, and Grove
removes them again:

- when a job using the file is sent to a printer and no other queued,
  paused or retryable job still needs it (Archive keeps its own copy), or
- when the periodic sweep finds one older than the retention window that
  no live job references.

The print dialog queues one request per printer or plate, so the scheduler
can dispatch the first job before the dialog has created the rest. A File
whose newest job was queued within ``DISPATCH_GRACE`` is therefore kept at
dispatch, and the sweep removes it shortly afterwards once it has been sent
to a printer and nothing live needs it.

Removal is based on location only. Moving a file out of Temporary Files
keeps it: from then on it is an ordinary File and never removed here.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.settings import Settings

logger = logging.getLogger(__name__)

TEMPORARY_FOLDER_KEY = "temporary_files"
TEMPORARY_FOLDER_NAME = "Temporary Files"

RETENTION_KEY = "library_temporary_retention_days"
DEFAULT_RETENTION_DAYS = 7
MIN_RETENTION_DAYS = 1
MAX_RETENTION_DAYS = 365

# Queue states in which a job may still read its library source. ``skipped``
# rows can be restored to ``pending`` by "Resume after failure"; a pending row
# with ``manual_start`` is the paused case. Rows that already carry an
# ``archive_id`` print from the Archive copy and no longer need the File.
LIVE_QUEUE_STATUSES = ("pending", "skipped", "preheating", "dispatching")

# How long after a File's newest job was queued the dialog may still be
# adding jobs for the same File (see module docstring).
DISPATCH_GRACE = timedelta(minutes=2)


def system_folder_ids_subquery():
    """SELECT of every Grove-managed folder id, for exclusion filters."""
    return select(LibraryFolder.id).where(LibraryFolder.system_key.isnot(None))


def outside_system_folders():
    """Clause matching files that are not in a Grove-managed folder.

    Spelled with an explicit NULL branch: ``folder_id NOT IN (...)`` is NULL,
    not true, for root-level files.
    """
    return or_(
        LibraryFile.folder_id.is_(None),
        LibraryFile.folder_id.notin_(system_folder_ids_subquery()),
    )


async def get_temporary_folder(db: AsyncSession) -> LibraryFolder | None:
    result = await db.execute(select(LibraryFolder).where(LibraryFolder.system_key == TEMPORARY_FOLDER_KEY))
    return result.scalar_one_or_none()


async def get_temporary_folder_id(db: AsyncSession) -> int | None:
    result = await db.execute(select(LibraryFolder.id).where(LibraryFolder.system_key == TEMPORARY_FOLDER_KEY))
    return result.scalar_one_or_none()


async def ensure_temporary_folder(db: AsyncSession) -> LibraryFolder:
    """Return the Temporary Files folder, creating it on first use."""
    folder = await get_temporary_folder(db)
    if folder is not None:
        return folder
    folder = LibraryFolder(name=TEMPORARY_FOLDER_NAME, parent_id=None, system_key=TEMPORARY_FOLDER_KEY)
    db.add(folder)
    try:
        await db.commit()
    except IntegrityError:
        # Another request created it first; the unique index on system_key
        # rejected this one.
        await db.rollback()
        existing = await get_temporary_folder(db)
        if existing is None:
            raise
        return existing
    await db.refresh(folder)
    logger.info("Created Temporary Files system folder (id=%s)", folder.id)
    return folder


def _live_item_clause():
    return and_(
        PrintQueueItem.status.in_(LIVE_QUEUE_STATUSES),
        PrintQueueItem.archive_id.is_(None),
    )


def live_reference_clause(exclude_item_id: int | None = None):
    """Clause matching LibraryFile rows that a live queue job still needs.

    Covers both the job's own source and the cross-model candidates (#671)
    a pending job may still switch to.
    """
    direct = select(PrintQueueItem.id).where(
        PrintQueueItem.library_file_id == LibraryFile.id,
        _live_item_clause(),
    )
    variant = (
        select(PrintQueueVariant.id)
        .join(PrintQueueItem, PrintQueueItem.id == PrintQueueVariant.queue_item_id)
        .where(
            PrintQueueVariant.library_file_id == LibraryFile.id,
            _live_item_clause(),
        )
    )
    if exclude_item_id is not None:
        direct = direct.where(PrintQueueItem.id != exclude_item_id)
        variant = variant.where(PrintQueueItem.id != exclude_item_id)
    return or_(exists(direct), exists(variant))


async def has_live_reference(db: AsyncSession, file_id: int, exclude_item_id: int | None = None) -> bool:
    result = await db.execute(
        select(LibraryFile.id).where(LibraryFile.id == file_id, live_reference_clause(exclude_item_id))
    )
    return result.scalar_one_or_none() is not None


def _utcnow_naive() -> datetime:
    # created_at columns are naive server_default timestamps (UTC).
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _newest_reference_subquery():
    return (
        select(func.max(PrintQueueItem.created_at))
        .where(PrintQueueItem.library_file_id == LibraryFile.id)
        .scalar_subquery()
    )


async def should_remove_after_dispatch(
    db: AsyncSession,
    item: PrintQueueItem,
    library_file: LibraryFile,
    temporary_folder_id: int | None,
) -> bool:
    """Whether dispatching ``item`` should delete its source File.

    Only Files still in Temporary Files are removed. ``cleanup_library_after_dispatch``
    is honoured for queue rows created before #237 whose upload is still at
    the root where the old flow placed it.
    """
    if library_file.is_external:
        return False
    in_temporary = temporary_folder_id is not None and library_file.folder_id == temporary_folder_id
    legacy = bool(getattr(item, "cleanup_library_after_dispatch", False)) and library_file.folder_id is None
    if not (in_temporary or legacy):
        return False
    if await has_live_reference(db, library_file.id, exclude_item_id=item.id):
        return False
    if in_temporary:
        # The dialog may still be queuing more jobs for this File; leave it
        # for the sweep. Legacy rows were only flagged for single-job
        # submissions, so they need no grace.
        newest = await db.scalar(
            select(func.max(PrintQueueItem.created_at)).where(PrintQueueItem.library_file_id == library_file.id)
        )
        if newest is not None and newest > _utcnow_naive() - DISPATCH_GRACE:
            return False
    return True


async def _read_setting(db: AsyncSession, key: str) -> str | None:
    result = await db.execute(select(Settings.value).where(Settings.key == key))
    return result.scalar_one_or_none()


async def get_retention_days(db: AsyncSession) -> int:
    raw = await _read_setting(db, RETENTION_KEY)
    if raw is None:
        return DEFAULT_RETENTION_DAYS
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_DAYS
    return max(MIN_RETENTION_DAYS, min(MAX_RETENTION_DAYS, days))


async def set_retention_days(db: AsyncSession, days: int) -> int:
    clamped = max(MIN_RETENTION_DAYS, min(MAX_RETENTION_DAYS, int(days)))
    result = await db.execute(select(Settings).where(Settings.key == RETENTION_KEY))
    row = result.scalar_one_or_none()
    if row is None:
        db.add(Settings(key=RETENTION_KEY, value=str(clamped)))
    else:
        row.value = str(clamped)
    await db.commit()
    return clamped


async def delete_library_files(db: AsyncSession, files: list[LibraryFile]) -> None:
    """Hard-delete Temporary Files rows and their bytes (no trash stage)."""
    if not files:
        return
    from backend.app.services.library_trash import (
        LibraryTrashService,
        delete_dependent_variants,
        release_queue_references,
    )

    ids = [f.id for f in files]
    for row in files:
        LibraryTrashService._unlink_on_disk(row)
    await release_queue_references(db, ids)
    await delete_dependent_variants(db, ids)
    await db.execute(delete(LibraryFile).where(LibraryFile.id.in_(ids)))


async def sweep_temporary_files(db: AsyncSession, now: datetime | None = None) -> int:
    """Remove Temporary Files that nothing live needs any more.

    A File qualifies when no live job references it and either it is older
    than the retention window (abandoned), or it has already been sent to a
    printer and its newest job is past ``DISPATCH_GRACE`` (kept at dispatch
    while the dialog might still have been queuing jobs for it).
    """
    folder_id = await get_temporary_folder_id(db)
    if folder_id is None:
        return 0
    retention = await get_retention_days(db)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(tzinfo=None)
    cutoff = now - timedelta(days=retention)

    dispatched = exists(
        select(PrintQueueItem.id).where(
            PrintQueueItem.library_file_id == LibraryFile.id,
            PrintQueueItem.archive_id.isnot(None),
        )
    )
    result = await db.execute(
        select(LibraryFile).where(
            LibraryFile.folder_id == folder_id,
            LibraryFile.is_external.is_(False),
            ~live_reference_clause(),
            or_(
                LibraryFile.created_at < cutoff,
                and_(dispatched, _newest_reference_subquery() < now - DISPATCH_GRACE),
            ),
        )
    )
    rows = list(result.scalars().all())
    if not rows:
        return 0
    await delete_library_files(db, rows)
    await db.commit()
    logger.info(
        "Temporary Files sweep: removed %d file(s) (retention %d day(s)): %s",
        len(rows),
        retention,
        [r.id for r in rows],
    )
    return len(rows)


async def migrate_abandoned_direct_uploads(db: AsyncSession) -> list[int]:
    """Move pre-#237 direct uploads that were never printed into Temporary Files.

    A root-level File qualifies only when every queue row that references it
    is a direct-upload job (``cleanup_library_after_dispatch``) that was
    cancelled or failed. Root-level Files with no queue history could be
    deliberate uploads and stay where they are. Idempotent: a moved File is
    no longer at the root, so a second run finds nothing.
    """
    folder_id = (await ensure_temporary_folder(db)).id

    any_direct = select(PrintQueueItem.id).where(
        PrintQueueItem.library_file_id == LibraryFile.id,
        PrintQueueItem.cleanup_library_after_dispatch.is_(True),
    )
    other_use = select(PrintQueueItem.id).where(
        PrintQueueItem.library_file_id == LibraryFile.id,
        or_(
            PrintQueueItem.cleanup_library_after_dispatch.isnot(True),
            PrintQueueItem.status.notin_(("cancelled", "failed")),
        ),
    )
    variant_use = select(PrintQueueVariant.id).where(PrintQueueVariant.library_file_id == LibraryFile.id)
    result = await db.execute(
        select(LibraryFile).where(
            LibraryFile.folder_id.is_(None),
            LibraryFile.deleted_at.is_(None),
            LibraryFile.is_external.is_(False),
            exists(any_direct),
            ~exists(other_use),
            ~exists(variant_use),
        )
    )
    rows = list(result.scalars().all())
    for row in rows:
        row.folder_id = folder_id
    if rows:
        await db.commit()
        logger.info(
            "Temporary Files migration: moved %d abandoned direct upload(s): %s",
            len(rows),
            [(r.id, r.filename) for r in rows],
        )
    return [r.id for r in rows]


class TemporaryFilesService:
    """Creates the folder at startup and runs the periodic sweep."""

    def __init__(self):
        self._scheduler_task: asyncio.Task | None = None
        # Short enough that Files kept through the dispatch grace go soon after.
        self._check_interval = 300

    async def start_scheduler(self):
        if self._scheduler_task is not None:
            return
        try:
            async with async_session() as db:
                await ensure_temporary_folder(db)
                await migrate_abandoned_direct_uploads(db)
                await sweep_temporary_files(db)
        except Exception as e:
            logger.error("Temporary Files startup pass failed: %s", e, exc_info=True)
        logger.info("Starting Temporary Files sweeper")
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    def stop_scheduler(self):
        if self._scheduler_task:
            self._scheduler_task.cancel()
            self._scheduler_task = None
            logger.info("Stopped Temporary Files sweeper")

    async def _scheduler_loop(self):
        while True:
            try:
                await asyncio.sleep(self._check_interval)
                async with async_session() as db:
                    await sweep_temporary_files(db)
            except asyncio.CancelledError:
                break
            except Exception as e:  # pragma: no cover - defensive
                logger.error("Error in Temporary Files sweeper: %s", e)
                await asyncio.sleep(60)


temporary_files_service = TemporaryFilesService()
