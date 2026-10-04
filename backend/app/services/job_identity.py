"""Job attribution for queue, MQTT and recovery (#194 stage 2).

Names are display data. Only an observed identity can select a job. Local
prints with no firmware ID get a session ID from the MQTT client; after an
application restart that ID cannot prove continuity, so the old job stays put.
"""

from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.queue_transitions import (
    ACTIVE_STATUSES,
    AWAITING_PLATE_CLEAR_STATUSES,
    HOLDING_STATUSES,
    transition_queue_item,
)


def normalize_id(value) -> str | None:
    value = str(value).strip() if value is not None else ""
    return value if value and value != "0" else None


def event_identity(data: dict) -> str | None:
    # An explicit snapshot wins over a partial/raw MQTT payload.
    if "submission_id" in data:
        return normalize_id(data["submission_id"])
    if "subtask_id" in data:
        return normalize_id(data["subtask_id"])
    return normalize_id((data.get("raw_data") or {}).get("subtask_id"))


def telemetry_identity(state) -> str | None:
    return normalize_id(getattr(state, "submission_id", None)) or normalize_id(getattr(state, "subtask_id", None))


def needs_dispatch_resolution(item: PrintQueueItem) -> bool:
    # The reservation covers preparation too. A live upload/Archive worker
    # has not yet handed the attempt to confirmation; it cannot be resolved
    # as printing (or failed) while that worker may still send the command.
    if (
        item.status != "dispatching"
        or item.dispatching_at is not None
        or not normalize_id(item.dispatch_subtask_id)
        or item.dispatched_at is None
    ):
        return False
    sent = item.dispatched_at
    return (datetime.now(timezone.utc) - sent.replace(tzinfo=timezone.utc)).total_seconds() >= 270


async def find_job(db: AsyncSession, printer_id: int, identity: str | None, statuses=ACTIVE_STATUSES):
    if not identity:
        return None
    rows = list(
        (
            await db.scalars(
                select(PrintQueueItem).where(
                    PrintQueueItem.printer_id == printer_id,
                    PrintQueueItem.dispatch_subtask_id == identity,
                    PrintQueueItem.status.in_(statuses),
                )
            )
        ).all()
    )
    # Reused external IDs or legacy duplicates are not evidence of identity.
    return rows[0] if len(rows) == 1 else None


async def sync_print_state(db: AsyncSession, item: PrintQueueItem, state) -> bool:
    """Apply a fresh, matching PAUSE/RUNNING observation without releasing the hold.

    Preparation and uncertain/offline telemetry do not resume a paused job.
    Callers own the transaction; duplicate observations do not write anything.
    """
    if (
        item.status not in ("printing", "paused")
        or state is None
        or not state.connected
        or not getattr(state, "job_telemetry_ready", True)
        or not normalize_id(item.dispatch_subtask_id)
        or telemetry_identity(state) != item.dispatch_subtask_id
    ):
        return False
    destination = {"PAUSE": "paused", "RUNNING": "printing"}.get(state.state)
    if destination is None or destination == item.status:
        return False
    await transition_queue_item(
        db,
        item,
        item.status,
        destination,
        conditions=(
            PrintQueueItem.printer_id == item.printer_id,
            PrintQueueItem.dispatch_subtask_id == item.dispatch_subtask_id,
        ),
    )
    return True


async def bind_observed_id(db: AsyncSession, printer_id: int, identity: str | None, previous: str | None):
    """Bind a session-local job to the firmware ID observed later in that run."""
    if not identity or not previous or identity == previous:
        return
    # An already-used firmware ID cannot establish a new association.
    if (
        await db.scalar(
            select(PrintQueueItem.id)
            .where(PrintQueueItem.printer_id == printer_id, PrintQueueItem.dispatch_subtask_id == identity)
            .limit(1)
        )
        is not None
    ):
        return
    item = await find_job(db, printer_id, previous, ("printing", "paused"))
    if item is None:
        return
    await transition_queue_item(
        db,
        item,
        item.status,
        item.status,
        values={"dispatch_subtask_id": identity},
        conditions=(PrintQueueItem.dispatch_subtask_id == previous,),
    )
    from backend.app.models.archive import PrintArchive

    # Creation records the attempt's owner before the Queue projection links
    # it. A transient link failure must not detach it when firmware reports
    # its ID later; the unique owner column identifies the same attempt.
    await db.execute(
        update(PrintArchive)
        .where(
            PrintArchive.dispatched_queue_item_id == item.id,
            PrintArchive.printer_id == printer_id,
            PrintArchive.subtask_id == previous,
        )
        .values(subtask_id=identity)
    )


async def observe_print(
    db: AsyncSession, printer_id: int, identity: str | None, *, observed_state=None, active_snapshot: bool = False
) -> tuple[PrintQueueItem | None, bool]:
    """Attach an observed active print, or create its external job atomically.

    The printer row serializes duplicate callbacks on SQLite and PostgreSQL.
    The existing unique active-printer index also fences scheduler dispatch.
    Never displace a different or unidentifiable active reservation. Fresh
    telemetry can establish a new external run on a plate still held by an
    ended job. In that case, transfer the hold in this transaction; the
    printer never becomes free, and the previous physical outcome is retained.
    """
    if not identity:
        return None, False
    locked = await db.execute(update(Printer).where(Printer.id == printer_id).values(id=Printer.id))
    if not locked.rowcount:
        return None, False
    item = await find_job(db, printer_id, identity)
    if item:
        confirmed = item.status == "dispatching"
        if confirmed:
            await transition_queue_item(
                db,
                item,
                "dispatching",
                "printing",
                values={
                    "started_at": datetime.now(timezone.utc),
                    "error_message": None,
                },
            )
        await sync_print_state(db, item, observed_state)
        return item, confirmed
    ended = await db.scalar(
        select(PrintQueueItem.id)
        .where(
            PrintQueueItem.printer_id == printer_id,
            PrintQueueItem.dispatch_subtask_id == identity,
            PrintQueueItem.status.in_(("finished", "failed", "cancelled", "successful", "unsuccessful")),
        )
        .limit(1)
    )
    if ended is not None:
        return None, False  # A duplicate/delayed start cannot revive a finished job.
    held = await db.scalar(
        select(PrintQueueItem)
        .where(PrintQueueItem.printer_id == printer_id, PrintQueueItem.status.in_(HOLDING_STATUSES))
        .execution_options(populate_existing=True)
    )
    if held is not None:
        active_states = ("PREPARE", "SLICING", "RUNNING", "PAUSE")
        # Check the live, mutable state after acquiring the printer/row locks.
        # A start that waited behind another callback may now be stale.
        replace_awaiting = (
            observed_state is not None
            and observed_state.connected
            and getattr(observed_state, "job_telemetry_ready", True)
            and telemetry_identity(observed_state) == identity
            and (
                observed_state.state in active_states
                or (active_snapshot and observed_state.state in ("FINISH", "FAILED", "IDLE"))
            )
        )
        if not replace_awaiting or held.status not in AWAITING_PLATE_CLEAR_STATUSES:
            return None, False
        reason = f"Printer hold transferred to externally started print {identity}"
        await transition_queue_item(
            db,
            held,
            held.status,
            "successful" if held.status == "finished" else "unsuccessful",
            action="hold_transferred",
            values={"error_message": f"{held.error_message}; {reason}" if held.error_message else reason},
        )
    item = PrintQueueItem(
        printer_id=printer_id, status="printing", dispatch_subtask_id=identity, started_at=datetime.now(timezone.utc)
    )
    db.add(item)
    await db.flush()
    await sync_print_state(db, item, observed_state)
    return item, False
