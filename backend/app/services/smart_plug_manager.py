"""Manager for smart plug automation and delayed turn-off."""

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.tasks import spawn_background_task
from backend.app.services.homeassistant import homeassistant_service
from backend.app.services.printer_manager import printer_manager
from backend.app.services.rest_smart_plug import rest_smart_plug_service
from backend.app.services.tasmota import tasmota_service
from backend.app.utils.local_time import next_local_hour, to_naive_utc, utcnow_naive

if TYPE_CHECKING:
    from backend.app.models.smart_plug import SmartPlug

logger = logging.getLogger(__name__)


class SmartPlugManager:
    """Manages smart plug automation and delayed turn-off."""

    def __init__(self):
        self._pending_off: dict[int, asyncio.Task] = {}  # plug_id -> task
        self._loop: asyncio.AbstractEventLoop | None = None
        self._scheduler_task: asyncio.Task | None = None
        self._snapshot_task: asyncio.Task | None = None
        self._last_schedule_check: dict[int, str] = {}  # plug_id -> "HH:MM" last executed

    async def get_service_for_plug(self, plug: "SmartPlug", db: AsyncSession | None = None):
        """Get the appropriate service for the plug type.

        For HA plugs, configures the service with current settings from DB.
        """
        if plug.plug_type == "homeassistant":
            # Configure HA service with current settings
            await self._configure_ha_service(db)
            return homeassistant_service
        if plug.plug_type == "rest":
            return rest_smart_plug_service
        return tasmota_service

    async def _configure_ha_service(self, db: AsyncSession | None = None):
        """Configure the HA service with URL and token from settings."""
        from backend.app.api.routes.settings import get_homeassistant_settings

        try:
            if db:
                # Use provided session
                ha_settings = await get_homeassistant_settings(db)
            else:
                # Create new session
                from backend.app.core.database import async_session

                async with async_session() as session:
                    ha_settings = await get_homeassistant_settings(session)

            homeassistant_service.configure(ha_settings["ha_url"], ha_settings["ha_token"])
        except Exception as e:
            logger.warning("Failed to configure HA service: %s", e)

    def set_event_loop(self, loop: asyncio.AbstractEventLoop):
        """Set the event loop for async operations."""
        self._loop = loop

    def start_scheduler(self):
        """Start the background scheduler for time-based plug control."""
        if self._scheduler_task is None:
            self._scheduler_task = asyncio.create_task(self._schedule_loop())
            logger.info("Smart plug scheduler started")
        if self._snapshot_task is None:
            self._snapshot_task = asyncio.create_task(self._snapshot_loop())
            logger.info("Smart plug energy snapshot loop started")

    def stop_scheduler(self):
        """Stop the background scheduler."""
        if self._scheduler_task:
            self._scheduler_task.cancel()
            self._scheduler_task = None
            logger.info("Smart plug scheduler stopped")
        if self._snapshot_task:
            self._snapshot_task.cancel()
            self._snapshot_task = None
            logger.info("Smart plug energy snapshot loop stopped")

    async def _schedule_loop(self):
        """Background loop that checks scheduled on/off times every minute."""
        while True:
            try:
                await self._check_schedules()
            except Exception as e:
                logger.error("Error in schedule check: %s", e)

            # Wait until the next minute
            await asyncio.sleep(60)

    async def _snapshot_loop(self):
        """Background loop that captures each plug's lifetime energy counter.

        Powers date-range queries in "total consumption" energy mode (#941) and,
        since #2539, the derived Today / Yesterday figures for every plug that
        reports only a cumulative counter.

        Ticks on the local hour rather than every 3600s from boot. That is what
        makes the derivation exact: a drifting timer leaves the last snapshot
        before midnight up to an hour early, and an hour of a printer's draw is
        a real number of watt-hours to lose off the day boundary. Aligning to the
        *local* hour also lands a tick on local midnight in the half-hour-offset
        timezones (India, Nepal), where midnight is not on a UTC hour at all.
        """
        # Short warm-up delay so other services finish booting; still gives us an
        # initial snapshot well before the first boundary.
        await asyncio.sleep(30)
        while True:
            try:
                await self._capture_energy_snapshots()
            except Exception as e:
                logger.error("Error in energy snapshot capture: %s", e)

            now = datetime.now(timezone.utc)
            delay = (next_local_hour(now) - now).total_seconds()
            await asyncio.sleep(max(delay, 60))

    async def _capture_energy_snapshots(self):
        """Capture one energy snapshot row per plug with a usable lifetime counter."""
        from backend.app.core.database import async_session
        from backend.app.models.smart_plug import SmartPlug
        from backend.app.models.smart_plug_energy_snapshot import SmartPlugEnergySnapshot

        async with async_session() as db:
            plugs_result = await db.execute(select(SmartPlug).where(SmartPlug.enabled.is_(True)))
            plugs = list(plugs_result.scalars().all())
            if not plugs:
                return

            # Naive UTC: the column is naive, and asyncpg rejects an aware value
            # outright (SQLite quietly drops the offset, which is why this went
            # unnoticed — on Postgres the whole capture raised).
            now = utcnow_naive()
            captured = 0
            for plug in plugs:
                # MQTT plugs only publish a "today" counter that resets at midnight —
                # they can never feed cumulative snapshots, so skip them outright to
                # avoid a noisy tasmota-service fallback attempt on an IP-less plug.
                if plug.plug_type == "mqtt":
                    continue
                try:
                    service = await self.get_service_for_plug(plug, db)
                    energy = await service.get_energy(plug)
                except Exception as e:
                    logger.debug("Snapshot: failed to read energy from plug %s: %s", plug.id, e)
                    continue
                if not energy:
                    continue
                lifetime = energy.get("total")
                if lifetime is None:
                    # The plug exposes no cumulative counter — a REST plug with only
                    # rest_energy_path set, say. Nothing to snapshot, and its Today
                    # comes straight from the device anyway.
                    continue
                db.add(
                    SmartPlugEnergySnapshot(
                        plug_id=plug.id,
                        recorded_at=now,
                        lifetime_kwh=float(lifetime),
                    )
                )
                captured += 1

            if captured:
                await db.commit()
                logger.info("Captured %d energy snapshot(s)", captured)

    async def _check_schedules(self):
        """Check all plugs for scheduled on/off times."""
        from backend.app.core.database import async_session
        from backend.app.models.smart_plug import SmartPlug

        current_time = datetime.now().strftime("%H:%M")

        async with async_session() as db:
            result = await db.execute(
                select(SmartPlug).where(
                    SmartPlug.enabled.is_(True),
                    SmartPlug.schedule_enabled.is_(True),
                )
            )
            plugs = result.scalars().all()

            for plug in plugs:
                service = await self.get_service_for_plug(plug, db)

                # Check if we should turn on
                if plug.schedule_on_time == current_time:
                    last_check = self._last_schedule_check.get(plug.id)
                    if last_check != f"on:{current_time}":
                        logger.info("Schedule: Turning on plug '%s' at %s", plug.name, current_time)
                        success = await service.turn_on(plug)
                        if success:
                            plug.last_state = "ON"
                            plug.last_checked = utcnow_naive()
                            self._last_schedule_check[plug.id] = f"on:{current_time}"

                # Check if we should turn off
                if plug.schedule_off_time == current_time:
                    last_check = self._last_schedule_check.get(plug.id)
                    if last_check != f"off:{current_time}":
                        logger.info("Schedule: Turning off plug '%s' at %s", plug.name, current_time)
                        success = await service.turn_off(plug)
                        if success:
                            plug.last_state = "OFF"
                            plug.last_checked = utcnow_naive()
                            self._last_schedule_check[plug.id] = f"off:{current_time}"
                            # Mark printer offline if this plug feeds it (#2629)
                            if plug.printer_id and plug.controls_printer_power:
                                printer_manager.mark_printer_offline(plug.printer_id)

            await db.commit()

    async def _get_plugs_for_printer(self, printer_id: int, db: AsyncSession) -> list["SmartPlug"]:
        """Get all smart plugs linked to a printer for automation control."""
        from backend.app.models.smart_plug import SmartPlug

        result = await db.execute(select(SmartPlug).where(SmartPlug.printer_id == printer_id))
        return list(result.scalars().all())

    async def on_print_start(self, printer_id: int, db: AsyncSession):
        """Called when a print starts - turn on all plugs linked to this printer."""
        plugs = await self._get_plugs_for_printer(printer_id, db)

        if not plugs:
            return

        for plug in plugs:
            # Cancel any pending off task before checking enabled: a re-print
            # must abort a scheduled auto-off even if the user disabled the
            # plug after the task was scheduled. Otherwise that stale task can
            # still cut power during the new print (#1890).
            self._cancel_pending_off(plug.id)

            if not plug.enabled:
                logger.debug("Smart plug '%s' is disabled, skipping auto-on", plug.name)
                continue

            if not plug.auto_on:
                logger.debug("Smart plug '%s' auto_on is disabled", plug.name)
                continue

            # Turn on the plug
            logger.info("Print started on printer %s, turning on plug '%s'", printer_id, plug.name)
            try:
                service = await self.get_service_for_plug(plug, db)
                success = await service.turn_on(plug)

                if success:
                    plug.last_state = "ON"
                    plug.last_checked = utcnow_naive()
                    plug.auto_off_executed = False  # Reset flag when turning on
            except Exception as e:
                logger.warning("Failed to turn on plug '%s' for printer %s: %s", plug.name, printer_id, e)

        await db.commit()

    async def turn_off_after_queue_job(self, printer_id: int, job_id: int, db: AsyncSession) -> None:
        """Immediately power off after a completed job if no work remains for the printer."""
        from backend.app.models.print_queue import PrintQueueItem
        from backend.app.services.lifecycle.engine import writer
        from backend.app.services.queue_work import printer_has_queue_work

        async with writer(printer_id):
            job = await db.get(PrintQueueItem, job_id, populate_existing=True)
            if (
                job is None
                or job.printer_id != printer_id
                or not job.auto_off_after
                or job.physical_outcome is None
                or job.status not in ("finished", "failed", "cancelled", "successful", "unsuccessful")
            ):
                return
            if await printer_has_queue_work(db, printer_id):
                logger.info("Queue job %s requested auto-off, but printer %s still has queue work", job_id, printer_id)
                return

            state = printer_manager.get_status(printer_id)
            if (
                not state
                or not state.connected
                or not getattr(state, "job_telemetry_ready", False)
                or state.state not in ("IDLE", "FINISH", "FAILED")
            ):
                logger.info(
                    "Skipping queue auto-off for printer %s: current printer state is not safely idle", printer_id
                )
                return

            plugs = await self._get_plugs_for_printer(printer_id, db)
            await db.commit()
            for plug in plugs:
                if not plug.enabled or (
                    plug.plug_type == "homeassistant" and plug.ha_entity_id and plug.ha_entity_id.startswith("script.")
                ):
                    continue
                try:
                    service = await self.get_service_for_plug(plug, db)
                    if await service.turn_off(plug):
                        await self._mark_auto_off_executed(plug.id)
                        if plug.controls_printer_power:
                            printer_manager.mark_printer_offline(printer_id)
                except Exception:
                    logger.exception("Could not turn off plug '%s' after queue job %s", plug.name, job_id)

    async def on_drying_complete(self, printer_id: int, db: AsyncSession):
        """Schedule turn-off for plugs flagged ``auto_off_after_drying`` when
        an AMS drying cycle finishes on this printer (#1349).

        Uses the drying-specific toggle and delay. Iterates every plug linked to the printer and
        fires only on the ones the user has opted-in via the per-plug
        toggle. Always uses the time-delay branch — temperature-based
        cooldown is about the printer's hotend, which isn't meaningful
        after a drying cycle (AMS chamber is the thing that's hot, and
        Grove Control doesn't track its temperature).
        """
        plugs = await self._get_plugs_for_printer(printer_id, db)
        if not plugs:
            return

        for plug in plugs:
            if not plug.enabled:
                logger.debug("Smart plug '%s' is disabled, skipping drying auto-off", plug.name)
                continue

            if not plug.auto_off_after_drying:
                logger.debug("Smart plug '%s' auto_off_after_drying is disabled, skipping", plug.name)
                continue

            # HA script entities can only be triggered, not turned off — same
            # guard the print-finish path uses.
            if plug.plug_type == "homeassistant" and plug.ha_entity_id and plug.ha_entity_id.startswith("script."):
                logger.debug("Smart plug '%s' is a HA script entity, skipping drying auto-off", plug.name)
                continue

            logger.info(
                "Drying completed on printer %s, scheduling turn-off for plug '%s' in %d min",
                printer_id,
                plug.name,
                plug.off_delay_after_drying_minutes,
            )
            self._schedule_delayed_off(plug, printer_id, plug.off_delay_after_drying_minutes * 60)

    def _schedule_delayed_off(
        self,
        plug: "SmartPlug",
        printer_id: int,
        delay_seconds: int,
    ):
        """Schedule turn-off after delay."""
        # Cancel any existing task for this plug
        self._cancel_pending_off(plug.id)

        logger.info("Scheduling turn-off for plug '%s' in %s seconds", plug.name, delay_seconds)

        # Mark as pending in database (survives restarts)
        spawn_background_task(self._mark_auto_off_pending(plug.id, True), name=f"plug-auto-off-pending-{plug.id}")

        task = asyncio.create_task(
            self._delayed_off(
                plug.id,
                plug.plug_type,
                plug.ip_address,
                plug.ha_entity_id,
                plug.username,
                plug.password,
                printer_id,
                delay_seconds,
                controls_printer_power=plug.controls_printer_power,
                rest_off_url=plug.rest_off_url if plug.plug_type == "rest" else None,
                rest_off_body=plug.rest_off_body if plug.plug_type == "rest" else None,
                rest_method=plug.rest_method if plug.plug_type == "rest" else None,
                rest_headers=plug.rest_headers if plug.plug_type == "rest" else None,
            )
        )
        self._pending_off[plug.id] = task

    async def _printer_has_active_work(self, printer_id: int) -> bool:
        """Protect reserved heat soaks/uploads before MQTT reports a loaded print."""
        from backend.app.core.database import async_session
        from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem

        if printer_manager.is_print_active(printer_id):
            return True
        try:
            async with async_session() as db:
                job_id = await db.scalar(
                    select(PrintQueueItem.id)
                    .where(PrintQueueItem.printer_id == printer_id, PrintQueueItem.status.in_(ACTIVE_STATUSES))
                    .limit(1)
                )
            return job_id is not None or printer_manager.is_print_active(printer_id)
        except Exception:
            logger.exception("Could not check active Queue work for printer %s; deferring auto-off", printer_id)
            return True

    async def _delayed_off(
        self,
        plug_id: int,
        plug_type: str,
        ip_address: str | None,
        ha_entity_id: str | None,
        username: str | None,
        password: str | None,
        printer_id: int,
        delay_seconds: int,
        *,
        controls_printer_power: bool = True,
        rest_off_url: str | None = None,
        rest_off_body: str | None = None,
        rest_method: str | None = None,
        rest_headers: str | None = None,
    ):
        """Wait and turn off."""
        try:
            await asyncio.sleep(delay_seconds)

            # #1890: never cut power while a print is loaded / running. The
            # delay fires unconditionally after N minutes, so if the user
            # re-started (or reprinted) in the meantime, the printer is active
            # again — skip the off and clear the pending flag rather than
            # killing the print mid-way.
            if printer_manager.is_print_active(printer_id):
                logger.info(
                    "Skipping auto-off for plug %s: printer %s is printing again (state=%s)",
                    plug_id,
                    printer_id,
                    getattr(printer_manager.get_status(printer_id), "state", "unknown"),
                )
                await self._mark_auto_off_pending(plug_id, False)
                return

            # Create a minimal plug-like object for the service
            class PlugInfo:
                def __init__(self):
                    self.plug_type = plug_type
                    self.ip_address = ip_address
                    self.ha_entity_id = ha_entity_id
                    self.username = username
                    self.password = password
                    self.name = f"plug_{plug_id}"
                    # REST fields
                    self.rest_off_url = rest_off_url
                    self.rest_off_body = rest_off_body
                    self.rest_method = rest_method
                    self.rest_headers = rest_headers

            plug_info = PlugInfo()
            service = await self.get_service_for_plug(plug_info)
            if await self._printer_has_active_work(printer_id):
                logger.info("Skipping auto-off for plug %s: printer %s has active Queue work", plug_id, printer_id)
                await self._mark_auto_off_pending(plug_id, False)
                return
            success = await service.turn_off(plug_info)
            logger.info("Turned off plug %s after time delay", plug_id)

            # Mark auto_off_executed in database and update printer status
            if success:
                await self._mark_auto_off_executed(plug_id)
                # Mark the printer as offline immediately — but only when this
                # plug actually feeds the printer (#2629).
                if controls_printer_power:
                    printer_manager.mark_printer_offline(printer_id)

        except asyncio.CancelledError:
            logger.debug("Delayed turn-off cancelled for plug %s", plug_id)
        finally:
            self._pending_off.pop(plug_id, None)

    async def _mark_auto_off_pending(self, plug_id: int, pending: bool):
        """Mark a plug as having a pending auto-off (survives restarts)."""
        try:
            from backend.app.core.database import async_session
            from backend.app.models.smart_plug import SmartPlug

            async with async_session() as db:
                result = await db.execute(select(SmartPlug).where(SmartPlug.id == plug_id))
                plug = result.scalar_one_or_none()
                if plug:
                    plug.auto_off_pending = pending
                    plug.auto_off_pending_since = utcnow_naive() if pending else None
                    plug.auto_off_pending_job_id = None
                    await db.commit()
                    logger.debug("Marked plug %s auto_off_pending=%s", plug_id, pending)
        except Exception as e:
            logger.warning("Failed to update plug %s pending state: %s", plug_id, e)

    async def _mark_auto_off_executed(self, plug_id: int):
        """Record that a smart plug was turned off."""
        try:
            from backend.app.core.database import async_session
            from backend.app.models.smart_plug import SmartPlug

            async with async_session() as db:
                result = await db.execute(select(SmartPlug).where(SmartPlug.id == plug_id))
                plug = result.scalar_one_or_none()
                if plug:
                    plug.auto_off_executed = True
                    plug.auto_off_pending = False  # Clear pending state
                    plug.auto_off_pending_since = None
                    plug.auto_off_pending_job_id = None
                    plug.last_state = "OFF"
                    plug.last_checked = utcnow_naive()
                    await db.commit()
                    logger.info("Auto-off executed for plug %s", plug_id)
        except Exception as e:
            logger.warning("Failed to update plug %s after auto-off: %s", plug_id, e)

    def _cancel_pending_off(self, plug_id: int):
        """Cancel any pending off task for this plug."""
        if plug_id in self._pending_off:
            logger.debug("Cancelling pending turn-off for plug %s", plug_id)
            self._pending_off[plug_id].cancel()
            del self._pending_off[plug_id]
            # Clear pending state in database
            spawn_background_task(self._mark_auto_off_pending(plug_id, False), name=f"plug-auto-off-pending-{plug_id}")

    def cancel_all_pending(self):
        """Cancel all pending turn-off tasks."""
        for plug_id in list(self._pending_off.keys()):
            self._cancel_pending_off(plug_id)

    async def resume_pending_auto_offs(self):
        """Resume only delayed drying auto-offs; queue-job auto-off is immediate."""
        try:
            from backend.app.core.database import async_session
            from backend.app.models.smart_plug import SmartPlug

            async with async_session() as db:
                # Find all plugs with pending auto-off
                result = await db.execute(
                    select(SmartPlug).where(
                        SmartPlug.auto_off_pending.is_(True),
                        SmartPlug.printer_id.isnot(None),
                    )
                )
                pending_plugs = result.scalars().all()

                for plug in pending_plugs:
                    if plug.auto_off_pending_job_id is not None:
                        # Older queue-job requests used delayed power-off. Never
                        # replay those under the immediate-only job policy.
                        plug.auto_off_pending = False
                        plug.auto_off_pending_since = None
                        plug.auto_off_pending_job_id = None
                        await db.commit()
                        continue

                    # The remaining pending requests are drying cooldowns.
                    if plug.auto_off_pending_since:
                        pending_since = to_naive_utc(plug.auto_off_pending_since)
                        elapsed = (utcnow_naive() - pending_since).total_seconds()
                        if elapsed > 7200:  # 2 hours
                            logger.warning(
                                "Drying auto-off for plug '%s' was pending for %.0f minutes; clearing stale state",
                                plug.name,
                                elapsed / 60,
                            )
                            plug.auto_off_pending = False
                            plug.auto_off_pending_since = None
                            await db.commit()
                            continue

                    if not plug.enabled or printer_manager.is_print_active(plug.printer_id):
                        plug.auto_off_pending = False
                        plug.auto_off_pending_since = None
                        await db.commit()
                        continue

                    elapsed = (
                        (utcnow_naive() - to_naive_utc(plug.auto_off_pending_since)).total_seconds()
                        if plug.auto_off_pending_since
                        else plug.off_delay_after_drying_minutes * 60
                    )
                    remaining = max(0, plug.off_delay_after_drying_minutes * 60 - int(elapsed))
                    self._schedule_delayed_off(plug, plug.printer_id, remaining)

                if pending_plugs:
                    logger.info("Resumed %s pending drying auto-off(s)", len(pending_plugs))

        except Exception as e:
            logger.warning("Failed to resume pending auto-offs: %s", e)


# Global singleton
smart_plug_manager = SmartPlugManager()
