"""Print scheduler service - processes the print queue."""

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.tasks import spawn_background_task
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import HOLDING_STATUSES, PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.ams_drying import AmsDrying
from backend.app.services.ams_mapping import AmsMapping
from backend.app.services.filament_deficit import compute_deficit_for_queue_item
from backend.app.services.ha_sensor_manager import ha_sensor_manager
from backend.app.services.lifecycle import dispatching
from backend.app.services.lifecycle.dispatching import Dispatcher, _DispatchBinding
from backend.app.services.lifecycle.preheating import ChamberHeatSoak
from backend.app.services.notification_service import notification_service
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import (
    _UPLOAD_POOL_WAITING_PREFIX,
    PrinterSelection,
)

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_MAX_CONCURRENT_UPLOADS = 1
MAX_QUEUE_CONCURRENT_UPLOADS = 16
ARCHIVE_RECONCILE_INTERVAL_SECONDS = 60


class PrintScheduler(Dispatcher, PrinterSelection, AmsMapping, AmsDrying):
    """Background scheduler that processes the print queue."""

    def __init__(self):
        super().__init__()
        self._running = False
        self._heat_soak = ChamberHeatSoak()
        self._check_interval = 30  # seconds
        self._fast_check_interval = 3  # seconds while dispatch work is draining

    async def run(self):
        """Main loop - check queue every interval."""
        self._running = True
        self._recovery_started_at = datetime.now(timezone.utc)
        logger.info("Print scheduler started")

        await self._clear_stale_dispatch_claims()
        next_archive_check = 0.0
        archive_check: asyncio.Task | None = None

        while self._running:
            dispatched = False
            try:
                dispatched = await self.check_queue()
            except Exception as e:
                logger.error("Scheduler error: %s", e)

            now = asyncio.get_running_loop().time()
            if now >= next_archive_check and (archive_check is None or archive_check.done()):
                from backend.app.main import reconcile_print_archives

                archive_check = spawn_background_task(reconcile_print_archives(), name="archive-reconciliation")
                next_archive_check = now + ARCHIVE_RECONCILE_INTERVAL_SECONDS

            await asyncio.sleep(self._fast_check_interval if dispatched else self._check_interval)

    def stop(self):
        """Stop the scheduler."""
        self._running = False
        # App shutdown also cancels the global task registry. Cancelling here
        # prevents a same-process restart from retaining upload reservations.
        for task, _printer_id in tuple(self._inflight.values()):
            if not task.done():
                task.cancel()
        logger.info("Print scheduler stopped")

    async def _check_heat_soaks(self, db: AsyncSession) -> set[int]:
        ready = await self._heat_soak.wait(db)
        await self.wait_unsent(db)
        for item_id in ready:
            dispatching.spawn_background_task(
                self._dispatch_after_heat_soak(item_id), name=f"heat-soak-dispatch-{item_id}"
            )
        return set((await db.scalars(select(Printer.id).where(Printer.heat_soak_shutdown_pending.is_(True)))).all())

    async def check_queue(self) -> bool:
        """Check for prints ready to start and report whether to tick quickly."""
        async with dispatching.async_session() as db:
            shutdown_printers = await self._check_heat_soaks(db)
            await self._recover_stale_dispatches(db)

            # Check if shortest-job-first scheduling is enabled
            sjf_enabled = await self._get_bool_setting(db, "queue_shortest_first")

            order = (PrintQueueItem.printer_id, PrintQueueItem.position)
            if sjf_enabled:
                order = (
                    PrintQueueItem.printer_id,
                    PrintQueueItem.target_model,
                    PrintQueueItem.been_jumped.desc(),
                    PrintQueueItem.print_time_seconds.asc().nullslast(),
                    PrintQueueItem.position,
                )
            result = await db.execute(
                select(PrintQueueItem)
                .where(PrintQueueItem.status == "queued", PrintQueueItem.dispatching_at.is_(None))
                .options(
                    selectinload(PrintQueueItem.archive),
                    selectinload(PrintQueueItem.library_file),
                    selectinload(PrintQueueItem.printer),
                    selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file),
                )
                .order_by(*order)
            )
            items = list(result.scalars().all())

            # Upload workers leave rows pending until they establish the
            # durable dispatch reservation. Exclude those rows so a fast tick
            # cannot send the same file twice.
            if self._inflight:
                items = [item for item in items if item.id not in self._inflight]

            # Read plate-clear setting once per queue check
            require_plate_clear = await self._get_bool_setting(db, "require_plate_clear", default=True)

            busy_result = await db.execute(
                select(PrintQueueItem.printer_id)
                .where(PrintQueueItem.status.in_(HOLDING_STATUSES))
                .where(PrintQueueItem.printer_id.is_not(None))
            )
            busy_printers: set[int] = {pid for (pid,) in busy_result.all() if pid is not None}

            busy_printers.update(shutdown_printers)

            # The durable status does not change until the upload completes;
            # reserve each worker's printer in memory for the same interval.
            busy_printers.update(pid for _task, pid in self._inflight.values() if pid is not None)

            try:
                await self._check_scheduled_dryings(db)
            except StopAsyncIteration:  # A finite mocked query sequence has no optional drying work.
                logger.debug("Scheduled drying check had no further mocked database results")

            if not items:
                # No dispatchable items — still check auto-drying, but do not
                # dry a printer whose upload is about to start printing.
                await self._check_auto_drying(db, [], busy_printers, require_plate_clear=require_plate_clear)
                return bool(self._inflight)

            logger.info(
                "Queue check: found %d pending items: %s",
                len(items),
                [(i.id, i.printer_id, i.archive_id, i.library_file_id) for i in items],
            )

            upload_limit = max(
                1,
                min(
                    MAX_QUEUE_CONCURRENT_UPLOADS,
                    await self._get_int_setting(
                        db,
                        "queue_max_concurrent_uploads",
                        default=DEFAULT_QUEUE_MAX_CONCURRENT_UPLOADS,
                    ),
                ),
            )
            available_slots = max(0, upload_limit - len(self._inflight))
            pool_waiting_reason = f"{_UPLOAD_POOL_WAITING_PREFIX} ({len(self._inflight)} of {upload_limit} in use)"

            # Active or unconfirmed dispatches remain reserved until telemetry settles them.

            # Keep interlocks separate from the printing set used by drying.
            interlocked: dict[int, str] = {}
            try:
                interlocked = await ha_sensor_manager.blocked_printers(db)
            except Exception as e:
                # A failed HA lookup is fail-open: the integration must not
                # stop the entire queue when HA itself is unavailable.
                logger.warning("Home Assistant interlock check failed: %s", e)
                interlocked = {}

            selection = await self._select_printers(
                db,
                items,
                busy_printers,
                interlocked,
                require_plate_clear=require_plate_clear,
                sjf_enabled=sjf_enabled,
                slots=available_slots,
                pool_reason=pool_waiting_reason,
            )
            dispatch_ids = list(selection.printers)
            if busy_printers:
                # Log why each printer was busy (first time it was checked)
                for pid in busy_printers:
                    state = printer_manager.get_status(pid)
                    connected = printer_manager.is_connected(pid)
                    awaiting = printer_manager.is_awaiting_plate_clear(pid)
                    state_name = state.state if state else "NO_STATUS"
                    logger.info(
                        "Queue: printer %d not available — connected=%s, state=%s, awaiting_plate_clear=%s",
                        pid,
                        connected,
                        state_name,
                        awaiting,
                    )

            # Commit selection metadata before workers open their independent sessions.
            if dispatch_ids or selection.changed:
                await db.commit()

            if dispatch_ids:
                # Record what each decision read only after the commit above,
                # so the worker compares against the committed row.
                items_by_id = {item.id: item for item in items}
                bindings = {
                    item_id: _DispatchBinding.for_item(
                        items_by_id[item_id],
                        printer_id,
                        selection.mappings.get(item_id),
                        unassigned=items_by_id[item_id].printer_id is None,
                    )
                    for item_id, printer_id in selection.printers.items()
                }
                self._launch_uploads(dispatch_ids, selection.printers, upload_limit, bindings)
                # Give newly-created workers one turn to acquire their own
                # sessions and reach the first I/O await. The scheduler still
                # returns without waiting for uploads to finish.
                await asyncio.sleep(0)

            # Auto-drying: start drying on idle printers that have no pending queue items
            await self._check_auto_drying(db, items, busy_printers, require_plate_clear=require_plate_clear)

            # Keep checking quickly while workers are active or work was selected
            # but deferred by a full pool.
            return bool(dispatch_ids) or bool(self._inflight)

    async def _get_setting(self, db: AsyncSession, key: str) -> str | None:
        """Read a setting value from the database."""
        result = await db.execute(select(Settings).where(Settings.key == key))
        setting = result.scalar_one_or_none()
        return setting.value if setting else None

    async def _get_bool_setting(self, db: AsyncSession, key: str, default: bool = False) -> bool:
        """Read a boolean setting from the database."""
        result = await db.execute(select(Settings).where(Settings.key == key))
        setting = result.scalar_one_or_none()
        if setting:
            return setting.value.lower() == "true"
        return default

    async def _get_int_setting(self, db: AsyncSession, key: str, default: int) -> int:
        """Read an integer setting, falling back safely for legacy rows."""
        try:
            value = await self._get_setting(db, key)
        except StopAsyncIteration:
            # A few lightweight scheduler tests provide a finite mocked query
            # sequence from before this optional setting existed. A missing
            # mocked row has the same semantics as an absent persisted row.
            value = None
        try:
            return int(value) if value is not None else default
        except (TypeError, ValueError):
            logger.warning("Invalid integer setting %s=%r; using %s", key, value, default)
            return default

    async def _get_job_name(self, db: AsyncSession, item: PrintQueueItem) -> str:
        """Get a human-readable name for a queue item."""
        if item.archive_id:
            result = await db.execute(select(PrintArchive).where(PrintArchive.id == item.archive_id))
            archive = result.scalar_one_or_none()
            if archive:
                return archive.filename.replace(".gcode.3mf", "").replace(".3mf", "")
        if item.library_file_id:
            result = await db.execute(LibraryFile.active().where(LibraryFile.id == item.library_file_id))
            library_file = result.scalar_one_or_none()
            if library_file:
                return library_file.filename.replace(".gcode.3mf", "").replace(".3mf", "")
        # Name an unbound cross-model job after its first candidate (#671).
        first_variant_name = (
            await db.execute(
                select(LibraryFile.filename)
                .join(PrintQueueVariant, PrintQueueVariant.library_file_id == LibraryFile.id)
                .where(PrintQueueVariant.queue_item_id == item.id)
                .order_by(PrintQueueVariant.position, PrintQueueVariant.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if first_variant_name:
            return first_variant_name.replace(".gcode.3mf", "").replace(".3mf", "")
        return f"Job #{item.id}"

    async def _get_printer(self, db: AsyncSession, printer_id: int) -> Printer | None:
        """Get printer by ID."""
        result = await db.execute(select(Printer).where(Printer.id == printer_id))
        return result.scalar_one_or_none()

    async def _block_on_filament_deficit(
        self,
        db: AsyncSession,
        item: PrintQueueItem,
        *,
        printer_id: int | None = None,
        ams_mapping: str | None = None,
    ) -> bool:
        """Promote the item to manual_start when the assigned spool is short (#1496).

        Returns True when this dispatch attempt was blocked, False when the
        item is clear to start. A previously-flagged item whose spool has
        since been swapped to one with enough material clears the flag here
        so the next scheduler tick dispatches it. ``printer_id`` and
        ``ams_mapping`` are the selected printer for an "Any machine" job.
        """
        # An explicit Print Anyway acknowledgement bypasses the deficit check.
        if item.skip_filament_check:
            # Keep the acknowledgement visible in support logs (#1762).
            logger.info(
                "Queue item %s honouring user's Print Anyway acknowledgement — skipping deficit check",
                item.id,
            )
            return False

        try:
            deficit = await compute_deficit_for_queue_item(db, item, printer_id=printer_id, ams_mapping=ams_mapping)
        except Exception as e:
            # Never let a flaky deficit check wedge the queue — log and let
            # dispatch proceed. The PrintModal-side check still runs on the
            # manual paths.
            logger.warning("Filament deficit check failed for item %s: %s", item.id, e)
            return False

        if deficit:
            item.filament_short = True
            item.manual_start = True
            await db.commit()
            job_name = await self._get_job_name(db, item)
            printer = await self._get_printer(db, item.printer_id) if item.printer_id else None
            logger.info(
                "Queue item %s blocked on filament deficit (%d slot(s)) — promoted to manual_start",
                item.id,
                len(deficit),
            )
            try:
                await notification_service.on_queue_job_waiting(
                    job_name=job_name,
                    target_model=(printer.model if printer else "") or "",
                    waiting_reason="filament_short",
                    db=db,
                )
            except Exception as e:
                logger.debug("filament_short notification failed for item %s: %s", item.id, e)
            return True

        # No deficit — clear any stale flag from a previous tick.
        if item.filament_short:
            item.filament_short = False
            await db.commit()
        return False


# Global scheduler instance
scheduler = PrintScheduler()
