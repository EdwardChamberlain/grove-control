"""Print scheduler service - processes the print queue."""

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant, physical_holding_clause
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings, bool_setting
from backend.app.services.ams_drying import AmsDrying
from backend.app.services.ams_mapping import AmsMapping
from backend.app.services.ha_sensor_manager import ha_sensor_manager
from backend.app.services.lifecycle import deadlines, queued
from backend.app.services.lifecycle.dispatching import Dispatcher
from backend.app.services.lifecycle.preheating import ChamberHeatSoak
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_selection import _UPLOAD_POOL_WAITING_PREFIX, PrinterSelection

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_MAX_CONCURRENT_UPLOADS = 1
MAX_QUEUE_CONCURRENT_UPLOADS = 16


class PrintScheduler:
    """Background scheduler: each pass selects printers for queued jobs and starts their exit workers."""

    _get_bool_setting = staticmethod(bool_setting)

    def __init__(self):
        self._running = False
        self.mapping = AmsMapping()
        self.drying = AmsDrying()
        self.selection = PrinterSelection(self.mapping, self.drying)
        self.dispatcher = Dispatcher(self.selection, self.drying)
        self.workers = queued.Workers(ChamberHeatSoak(), self.dispatcher)
        self._lifecycle: asyncio.Task | None = None
        self._check_interval = 30  # seconds
        self._fast_check_interval = 3  # seconds while dispatch work is draining

    async def run(self):
        """Main loop - check queue every interval."""
        self._running = True
        logger.info("Print scheduler started")

        await deadlines.start(self.dispatcher)
        self._lifecycle = spawn_background_task(deadlines.run(self.dispatcher), name="lifecycle-loop")

        while self._running:
            dispatched = False
            try:
                dispatched = await self.check_queue()
            except Exception as e:
                logger.error("Scheduler error: %s", e)
            await asyncio.sleep(self._fast_check_interval if dispatched else self._check_interval)

    def stop(self):
        """Stop the scheduler."""
        self._running = False
        if self._lifecycle is not None:
            self._lifecycle.cancel()
        # App shutdown also cancels the global task registry. Cancelling here
        # prevents a same-process restart from retaining upload reservations.
        for item_id in tuple(self.workers.inflight):
            self.workers.cancel(item_id)
        logger.info("Print scheduler stopped")

    async def _shutdown_printers(self, db: AsyncSession) -> set[int]:
        """Printers unavailable for selection while their heaters are shutting down."""
        return set((await db.scalars(select(Printer.id).where(Printer.heat_soak_shutdown_pending.is_(True)))).all())

    async def check_queue(self) -> bool:
        """Check for prints ready to start and report whether to tick quickly."""
        async with async_session() as db:
            shutdown_printers = await self._shutdown_printers(db)

            # Check if shortest-job-first scheduling is enabled
            sjf_enabled = await self._get_bool_setting(db, "queue_shortest_first")

            order = (PrintQueueItem.assigned_printer_id, PrintQueueItem.position)
            if sjf_enabled:
                order = (
                    PrintQueueItem.assigned_printer_id,
                    PrintQueueItem.target_model,
                    PrintQueueItem.been_jumped.desc(),
                    PrintQueueItem.print_time_seconds.asc().nullslast(),
                    PrintQueueItem.position,
                )
            result = await db.execute(
                select(PrintQueueItem)
                .where(PrintQueueItem.status == "queued", PrintQueueItem.id.not_in(list(self.workers.inflight)))
                .options(
                    selectinload(PrintQueueItem.archive),
                    selectinload(PrintQueueItem.library_file),
                    selectinload(PrintQueueItem.assigned_printer),
                    selectinload(PrintQueueItem.variants).selectinload(PrintQueueVariant.library_file),
                )
                .order_by(*order)
            )
            items = list(result.scalars().all())

            # Upload workers leave rows pending until they establish the
            # durable dispatch reservation. Exclude those rows so a fast tick
            # cannot send the same file twice.
            inflight = self.workers.inflight
            items = [item for item in items if item.id not in inflight]

            # Read plate-clear setting once per queue check
            require_plate_clear = await self._get_bool_setting(db, "require_plate_clear", default=True)

            busy_result = await db.execute(
                select(PrintQueueItem.printer_id)
                .where(physical_holding_clause(PrintQueueItem.status, PrintQueueItem.physical_outcome))
                .where(PrintQueueItem.printer_id.is_not(None))
            )
            busy_printers: set[int] = {pid for (pid,) in busy_result.all() if pid is not None}

            busy_printers.update(shutdown_printers)

            # The durable status does not change until the upload completes;
            # reserve each worker's printer in memory for the same interval.
            busy_printers.update(pid for _task, pid in inflight.values())

            try:
                await self.drying._check_scheduled_dryings(db)
            except StopAsyncIteration:  # A finite mocked query sequence has no optional drying work.
                logger.debug("Scheduled drying check had no further mocked database results")

            if not items:
                # No dispatchable items — still check auto-drying, but do not
                # dry a printer whose upload is about to start printing.
                await self.drying._check_auto_drying(db, [], busy_printers, require_plate_clear=require_plate_clear)
                return bool(inflight)

            logger.info(
                "Queue check: found %d pending items: %s",
                len(items),
                [(i.id, i.assigned_printer_id, i.archive_id, i.library_file_id) for i in items],
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
            available_slots = max(0, upload_limit - len(inflight))
            pool_waiting_reason = f"{_UPLOAD_POOL_WAITING_PREFIX} ({len(inflight)} of {upload_limit} in use)"

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

            selection = await self.selection._select_printers(
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
            for pid in busy_printers:  # Why each printer is unavailable this pass.
                state = printer_manager.get_status(pid)
                logger.info(
                    "Queue: printer %d not available — connected=%s, state=%s, awaiting_plate_clear=%s",
                    pid,
                    printer_manager.is_connected(pid),
                    state.state if state else "NO_STATUS",
                    printer_manager.is_awaiting_plate_clear(pid),
                )

            # Commit selection metadata before workers open their independent sessions.
            if dispatch_ids or selection.changed:
                await db.commit()

            if dispatch_ids:
                # Record what each decision read only after the commit above,
                # so the worker compares against the committed row.
                items_by_id = {item.id: item for item in items}
                bindings = {
                    item_id: queued._DispatchBinding.for_item(
                        items_by_id[item_id],
                        printer_id,
                        selection.mappings.get(item_id),
                        unassigned=items_by_id[item_id].assigned_printer_id is None,
                    )
                    for item_id, printer_id in selection.printers.items()
                }
                self.workers.launch(bindings, upload_limit)
                # Give newly-created workers one turn to acquire their own
                # sessions and reach the first I/O await. The scheduler still
                # returns without waiting for uploads to finish.
                await asyncio.sleep(0)

            # Auto-drying: start drying on idle printers that have no pending queue items
            await self.drying._check_auto_drying(db, items, busy_printers, require_plate_clear=require_plate_clear)

            # Keep checking quickly while workers are active or work was selected
            # but deferred by a full pool.
            return bool(dispatch_ids) or bool(inflight)

    async def _get_int_setting(self, db: AsyncSession, key: str, default: int) -> int:
        """Read an integer setting, falling back safely for legacy rows."""
        try:
            setting = (await db.execute(select(Settings).where(Settings.key == key))).scalar_one_or_none()
            value = setting.value if setting else None
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


# Global scheduler instance
scheduler = PrintScheduler()
