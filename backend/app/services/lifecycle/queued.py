"""Queued (#204): a job waits in its queue until a printer is selected for it.

Enter: ``create_job`` adds every new job, from the Queue, Files, a webhook, a
virtual printer or Retry. Wait: each scheduler pass, printer selection picks a
printer and tray mapping in memory; nothing is written to the job. Exit: an
exit worker rechecks the printer and source, and starts preheating or
dispatching, whose entry holds the printer if the job is unchanged since its
selection; or a person cancels the job (unsuccessful). Recover: the job is
durable; nothing about a waiting job lives in memory.
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.core.config import settings
from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant, physical_holding_clause
from backend.app.models.printer import Printer
from backend.app.schemas.print_queue import PrintQueueItemUpdate
from backend.app.services.filament_requirements import build_queue_filament_overrides, extract_filament_requirements
from backend.app.services.lifecycle.engine import (
    QueueTransitionConflict,
    lock_queue_item,
    transition_queue_item,
    writer,
)
from backend.app.services.lifecycle.preheating import abort_heat_soak
from backend.app.services.notification_service import notification_service
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import (
    _incompatible_sliced_model_reason,
    _sliced_for_model,
    _source_nozzle_mismatch,
)

logger = logging.getLogger(__name__)
_EDITABLE_FIELDS = tuple(name for name in PrintQueueItemUpdate.model_fields if name in PrintQueueItem.__table__.columns)


def filament_contract(
    source: Path | None,
    plate_id: int | None = None,
    provided: list[dict] | None = None,
    *,
    force_color_match: bool = True,
) -> tuple[str | None, str | None]:
    """The materials a job needs and its per-slot filament overrides, as stored, from its sliced source.

    Raises ValueError for overrides the source doesn't allow.
    """
    requirements = extract_filament_requirements(source, plate_id) if source else []
    overrides = build_queue_filament_overrides(requirements, provided, force_color_match=force_color_match)
    types = {r["type"] for r in requirements if r.get("type")} | {o["type"] for o in overrides}
    return json.dumps(sorted(types)) if types else None, json.dumps(overrides) if overrides else None


async def create_job(
    db: AsyncSession,
    jobs: Sequence[Mapping],
    *,
    at: int | Literal["top"] | None = None,
    variants: Sequence[Mapping] = (),
) -> list[PrintQueueItem]:
    """Enter: add ``jobs`` to their queue, one after another, and flush them; the caller commits.

    The jobs share one queue: their printer's, or the pool for unassigned jobs.
    They join its end, or ``at`` a 1-based position that later jobs make room
    for, or ``"top"``: ahead of every waiting job that could take the same
    printer. Each job gets its own copy of ``variants``.
    """
    if not jobs:
        return []
    prepared = []
    for job in jobs:
        item_values = dict(job)
        # Queue endpoints historically called this preference ``printer_id``.
        # The row column now records only the immutable dispatch binding.
        assigned_printer_id = item_values.pop("assigned_printer_id", None)
        if "printer_id" in item_values:
            legacy_printer_id = item_values.pop("printer_id")
            if assigned_printer_id is None:
                assigned_printer_id = legacy_printer_id
        item_values["printer_id"] = None
        item_values["assigned_printer_id"] = assigned_printer_id
        item_values.setdefault("retry_on_failure", True)
        prepared.append(item_values)
    values = {}
    if variants:
        # The scheduler orders a job before its printer is known, by its shortest candidate.
        estimates = [variant["print_time_seconds"] for variant in variants if variant.get("print_time_seconds")]
        values["print_time_seconds"] = min(estimates) if estimates else None
    models = {model for model in (prepared[0].get("target_model"), *(v["target_model"] for v in variants)) if model}
    first = await _place(db, prepared[0].get("assigned_printer_id"), models, len(jobs), at)
    created = []
    for offset, job in enumerate(prepared):
        created.append(PrintQueueItem(**{**job, **values}, status="queued", position=first + offset))
        created[-1].variants.extend(PrintQueueVariant(**variant) for variant in variants)
        db.add(created[-1])
    await db.flush()
    return created


async def create_retry_job(db: AsyncSession, item: PrintQueueItem) -> PrintQueueItem:
    """Create one history-free replacement at the front of its queue.

    Automatic and manual retries share the same reset/copy rules. ``None``
    means none of the snapshotted sources is still available; automatic retry
    then leaves the failed job for review instead of creating an unusable row.
    """
    from backend.app.utils.safe_path import safe_join_under

    def source_available(source) -> bool:
        if source is None or source.deleted_at is not None:
            return False
        path = Path(source.file_path)
        path = path if path.is_absolute() else safe_join_under(settings.base_dir, source.file_path, http=False)
        return path.is_file()

    variants = list(
        (
            await db.scalars(
                select(PrintQueueVariant)
                .where(PrintQueueVariant.queue_item_id == item.id)
                .options(selectinload(PrintQueueVariant.library_file))
                .order_by(PrintQueueVariant.position, PrintQueueVariant.id)
            )
        ).all()
    )
    variants = [variant for variant in variants if source_available(variant.library_file)]
    source = await db.get(LibraryFile, item.library_file_id) if item.library_file_id is not None else None
    archive = await db.get(PrintArchive, item.archive_id) if item.archive_id is not None else None
    if not variants and not source_available(source) and not source_available(archive):
        return None

    retry_excluded = {
        "id",
        "created_at",
        "printer_id",
        "status",
        "position",
        "manual_start",
        "preheat_requested_at",
        "preheat_started_at",
        "deadline_at",
        "deadline_kind",
        "dispatched_at",
        "dispatch_subtask_id",
        "started_at",
        "completed_at",
        "error_message",
        "waiting_reason",
        "physical_outcome",
        "physical_completed_at",
        "physical_failure_reason",
        "stop_requested_at",
        "been_jumped",
        "retry_on_failure",
        "dispatch_stage",
    }
    values = {
        column.name: getattr(item, column.name)
        for column in PrintQueueItem.__table__.columns
        if column.name not in retry_excluded
    }
    values.update(
        printer_id=None,
        assigned_printer_id=item.assigned_printer_id,
        retry_on_failure=False,
        dispatch_stage=None,
        manual_start=False,
        preheat_requested_at=None,
        preheat_started_at=None,
        deadline_at=None,
        deadline_kind=None,
        dispatched_at=None,
        dispatch_subtask_id=None,
        started_at=None,
        completed_at=None,
        error_message=None,
        waiting_reason=None,
        physical_outcome=None,
        physical_completed_at=None,
        physical_failure_reason=None,
        stop_requested_at=None,
        been_jumped=False,
    )
    variant_values = [
        {
            column.name: getattr(variant, column.name)
            for column in PrintQueueVariant.__table__.columns
            if column.name not in {"id", "queue_item_id", "created_at", "attempt_count"}
        }
        for variant in variants
    ]
    if variant_values:
        values.update(
            library_file_id=None,
            archive_id=None,
            target_model=variant_values[0]["target_model"],
            cleanup_library_after_dispatch=False,
        )
        for field in ("plate_id", "ams_mapping", "nozzle_mapping", "filament_overrides", "required_filament_types"):
            values[field] = variant_values[0].get(field)
    if item.assigned_printer_id is None:
        # This job will be matched to a printer again. Tray indices belong to
        # that printer, so don't carry the previous dispatch's mapping into
        # the fresh job (or let a candidate variant restore it).
        values["ams_mapping"] = None
        for variant in variant_values:
            variant["ams_mapping"] = None
    elif variant_values:
        # The replacement will select one of these original library files.
        # The old dispatch Archive belongs only to the completed attempt.
        values["archive_id"] = None
    elif source_available(source):
        values["archive_id"] = None if item.library_file_id is not None else item.archive_id
    else:
        values["library_file_id"] = None
        values["cleanup_library_after_dispatch"] = False
    created = await create_job(db, [values], at="top", variants=variant_values)
    return created[0]


async def _place(
    db: AsyncSession, printer_id: int | None, models: set[str], quantity: int, at: int | str | None
) -> int:
    """The first position for new jobs, taken under a lock on their queue."""
    if db.get_bind().dialect.name == "postgresql":
        # SQLite serializes writes; an empty queue has no rows for PostgreSQL to lock.
        await db.execute(text("SELECT pg_advisory_xact_lock(1625, :k)"), {"k": printer_id or 0})
    printer = (
        PrintQueueItem.assigned_printer_id.is_(None)
        if printer_id is None
        else PrintQueueItem.assigned_printer_id == printer_id
    )
    queue = (PrintQueueItem.status == "queued", printer)
    if at == "top":
        if models:
            same = PrintQueueItem.variants.any(PrintQueueVariant.target_model.in_(models))
            queue = (*queue, PrintQueueItem.target_model.in_(models) | same)
        return (await db.scalar(select(func.min(PrintQueueItem.position)).where(*queue)) or 0) - 1
    last = await db.scalar(select(func.max(PrintQueueItem.position)).where(*queue)) or 0
    if at is None:
        return last + 1
    at = min(max(1, at), last + 1)
    await db.execute(
        update(PrintQueueItem)
        .where(*queue, PrintQueueItem.position >= at)
        .values(position=PrintQueueItem.position + quantity)
    )
    return at


@dataclass(frozen=True, slots=True)
class _DispatchBinding:
    """A selection decision handed to its exit worker."""

    printer_id: int
    ams_mapping: str | None
    unassigned: bool
    selected: tuple[tuple[str, object], ...] = ()

    @classmethod
    def for_item(cls, item: PrintQueueItem, printer_id: int, ams_mapping: str | None, *, unassigned: bool):
        fields = (*_EDITABLE_FIELDS, "assigned_printer_id")
        selected = tuple((name, getattr(item, name)) for name in fields if hasattr(item, name))
        return cls(printer_id, ams_mapping, unassigned, selected)

    def values(self) -> dict[str, int | str | None]:
        return {"printer_id": self.printer_id, "ams_mapping": self.ams_mapping}

    def edited_fields(self, item: PrintQueueItem) -> list[str]:
        return [name for name, value in self.selected if getattr(item, name) != value]


def _bind_in_memory(item: PrintQueueItem, printer_id: int | None, ams_mapping: str | None) -> None:
    """Evaluate a pool job against one printer without persisting the choice."""
    set_committed_value(item, "printer_id", printer_id)
    set_committed_value(item, "ams_mapping", ams_mapping)


async def blocker(db: AsyncSession, item: PrintQueueItem, printer: Printer | None) -> tuple[str, bool] | None:
    """Why ``printer`` can't print the job's source now, and whether a person must act; None if it can."""
    if printer is None:
        return "Printer not found", False
    archive = library_file = None
    if item.archive_id:
        query = select(PrintArchive).where(PrintArchive.id == item.archive_id)
        archive = await db.scalar(query.execution_options(populate_existing=True))
        if not archive or archive.deleted_at is not None:
            return ("Archive source was deleted" if archive else "Archive not found"), True
    elif item.library_file_id:
        library_file = await db.scalar(LibraryFile.active().where(LibraryFile.id == item.library_file_id))
        if not library_file:
            return "Library file not found", True
    else:
        return "No source file specified", True
    if reason := _incompatible_sliced_model_reason(_sliced_for_model(archive, library_file), printer):
        return reason, False
    if not (settings.base_dir / (archive or library_file).file_path).exists():
        return "Source file not found on disk", True
    # Only a positive nozzle mismatch blocks (#1899).
    reason = _source_nozzle_mismatch(archive, library_file, item.printer_id)
    return (reason, False) if reason else None


async def stay(db: AsyncSession, item: PrintQueueItem, reason: str, *, park: bool = False) -> None:
    """Keep a job in the pool with a display-only reason, parked for Manual start if a person must act."""
    values: dict[str, str | bool] = {"waiting_reason": reason, **({"manual_start": True} if park else {})}
    await transition_queue_item(db, item, "queued", "queued", values=values)
    await db.commit()
    logger.info("Queue item %s stays queued: %s", item.id, reason)


async def job_name(db: AsyncSession, item: PrintQueueItem) -> str:
    """A human-readable name for a job: its source file, or its first candidate's (#671)."""
    filename = None
    if item.archive_id:
        filename = await db.scalar(select(PrintArchive.filename).where(PrintArchive.id == item.archive_id))
    if not filename and item.library_file_id:
        active = (LibraryFile.id == item.library_file_id, LibraryFile.deleted_at.is_(None))
        filename = await db.scalar(select(LibraryFile.filename).where(*active))
    if not filename:
        filename = await db.scalar(
            select(LibraryFile.filename)
            .join(PrintQueueVariant, PrintQueueVariant.library_file_id == LibraryFile.id)
            .where(PrintQueueVariant.queue_item_id == item.id)
            .order_by(PrintQueueVariant.position, PrintQueueVariant.id)
            .limit(1)
        )
    return filename.replace(".gcode.3mf", "").replace(".3mf", "") if filename else f"Job #{item.id}"


async def notify_assignment(db: AsyncSession, item: PrintQueueItem) -> None:
    """Announce the printer an "Any machine" job was bound to on leaving the queue."""
    try:
        printer = await db.get(Printer, item.printer_id)
        await notification_service.on_queue_job_assigned(
            job_name=await job_name(db, item),
            printer_id=item.printer_id,
            printer_name=printer.name if printer else "Unknown",
            target_model=item.target_model,
            db=db,
        )
    except Exception:
        # The hold is committed; a notification failure must not fail it.
        logger.warning("Could not send assignment notification for queue item %s", item.id, exc_info=True)


# This process's exit and dispatch workers, by job: (task, printer). One process
# runs per database (lifecycle.lease), so this is the whole truth of which jobs
# a worker still owns.
_inflight: dict[int, tuple[asyncio.Task, int]] = {}


def in_flight(item_id: int) -> bool:
    """Whether a worker is still preparing or sending this job."""
    return item_id in _inflight


class Workers:
    """Exit workers: a bounded pool that takes selected jobs out of the queue, one session each."""

    def __init__(self, heat_soak, dispatcher):
        """``heat_soak`` and ``dispatcher`` are the next states' entries: preheating and dispatching."""
        self._heat_soak, self._dispatcher = heat_soak, dispatcher
        self.inflight = _inflight

    def launch(self, bindings: Mapping[int, _DispatchBinding], limit: int) -> None:
        """Start a worker per selected job while slots are free, at most one per printer."""
        reserved = {printer_id for _task, printer_id in self.inflight.values()}
        for item_id, binding in bindings.items():
            if len(self.inflight) >= limit:
                return
            if item_id in self.inflight or binding.printer_id in reserved:
                continue
            reserved.add(binding.printer_id)
            task = spawn_background_task(self._work(item_id, binding), name=f"queue-upload-{item_id}")
            self.inflight[item_id] = (task, binding.printer_id)
            task.add_done_callback(lambda done, item_id=item_id: self._forget(item_id, done))

    def track_io(self, item_id: int, printer_id: int, work: Callable[[], Awaitable], *, name: str) -> bool:
        """Track one persisted stage's currently running I/O for Stop and recovery."""
        current = self.inflight.get(item_id)
        task = asyncio.current_task()
        if current and not current[0].done() and current[0] is not task:
            return False
        task = spawn_background_task(work(), name=name)
        self.inflight[item_id] = (task, printer_id)
        task.add_done_callback(lambda done: self._forget(item_id, done))
        return True

    def _forget(self, item_id: int, done: asyncio.Task) -> None:
        current = self.inflight.get(item_id)
        if current and current[0] is done:
            self.inflight.pop(item_id, None)

    def cancel(self, item_id: int) -> bool:
        """Cancel a worker after its job has been cancelled or deleted."""
        task = self.inflight.get(item_id, (None,))[0]
        return bool(task and not task.done() and task.cancel())

    async def cancel_and_wait(self, item_id: int) -> None:
        """Drain an active upload before its cleanup effect can remove the remote file."""
        task = self.inflight.get(item_id, (None,))[0]
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _work(self, item_id: int, binding: _DispatchBinding) -> None:
        """Leave the queue in its own session; the hold itself checks the job is unchanged since selection."""
        async with async_session() as db:
            try:
                item = await db.get(PrintQueueItem, item_id)
                if item and item.status == "queued" and not binding.edited_fields(item):
                    await self.leave(db, item, binding)
            except asyncio.CancelledError:
                # Stop can land mid-write, such as the hold before its commit. Releasing the
                # claim commits, so discard the unfinished work first.
                await db.rollback()
                raise
            except QueueTransitionConflict:
                await db.rollback()
                logger.info("Queue item %s changed while leaving the queue", item_id)
            except Exception:
                await db.rollback()
                logger.exception("Exit worker failed for job %s", item_id)
                await _settle(db, item_id)

    async def leave(self, db: AsyncSession, item: PrintQueueItem, binding: _DispatchBinding | None = None) -> None:
        """Exit to the selected printer: preheating for a heat soak, otherwise dispatching.

        Checks read the selected printer and mapping in memory; only the next
        state's hold writes them. A disconnected or held printer is simply not
        available yet.
        """
        if binding is None and item.printer_id is None and item.assigned_printer_id is not None:
            # A fixed printer preference is itself the selection for callers
            # that enter this worker directly (for example, preheating handoff
            # and focused lifecycle tests). It remains unbound until the next
            # state's conditional hold commits.
            binding = _DispatchBinding.for_item(item, item.assigned_printer_id, item.ams_mapping, unassigned=False)
        original_mapping = item.ams_mapping
        if binding is not None:
            _bind_in_memory(item, binding.printer_id, binding.ams_mapping)
        printer = await db.get(Printer, item.printer_id)
        if printer and not printer_manager.is_connected(item.printer_id):
            problem = "Printer not connected", False
        elif printer and await db.scalar(
            select(PrintQueueItem.id)
            .where(
                PrintQueueItem.printer_id == item.printer_id,
                physical_holding_clause(PrintQueueItem.status, PrintQueueItem.physical_outcome),
            )
            .where(PrintQueueItem.id != item.id)
            .limit(1)
        ):
            return
        else:
            problem = await blocker(db, item, printer)
        if problem:
            if binding is not None:
                _bind_in_memory(item, None, original_mapping)
            await stay(db, item, problem[0], park=problem[1])
        elif getattr(item, "chamber_heat_soak", False) is not True:
            await self._dispatcher.enter(db, item, "queued", binding)
        else:
            if await self._heat_soak.enter(db, item, binding) and binding and binding.unassigned:
                await notify_assignment(db, item)


async def _settle(db: AsyncSession, item_id: int) -> None:
    """After an unexpected worker error, park a job still queued, or end a soak whose start failed."""
    try:
        snapshot = await db.get(PrintQueueItem, item_id)
        printer_id = snapshot.printer_id if snapshot is not None else None
        await db.rollback()
        if printer_id is None:
            async with writer(None):
                item = await lock_queue_item(db, item_id)
                if item and item.status == "queued":
                    await stay(db, item, "Dispatch preparation failed; check the logs, then start it again", park=True)
                else:
                    await db.rollback()
            return
        async with writer(printer_id):
            item = await lock_queue_item(db, item_id)
            if item and item.status == "queued":
                await stay(db, item, "Dispatch preparation failed; check the logs, then start it again", park=True)
            elif item and item.status == "preheating":
                await abort_heat_soak(db, item, "Heat soak failed to start; inspect the printer before retrying")
            else:
                await db.rollback()
    except Exception:
        await db.rollback()
        logger.exception("Could not settle queue item %s after an exit worker failure", item_id)
