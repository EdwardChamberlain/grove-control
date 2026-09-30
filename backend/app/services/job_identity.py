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
from backend.app.services.queue_transitions import transition_queue_item

ACTIVE_STATUSES = ("preheating", "dispatching", "printing")


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
    if item.status != "dispatching" or (item.chamber_heat_soak and not item.dispatch_subtask_id):
        return False
    sent = item.dispatched_at
    return sent is None or (datetime.now(timezone.utc) - sent.replace(tzinfo=timezone.utc)).total_seconds() >= 270


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
    item = await find_job(db, printer_id, previous, ("printing",))
    if item is None:
        return
    await transition_queue_item(
        db,
        item,
        "printing",
        "printing",
        values={"dispatch_subtask_id": identity},
        conditions=(PrintQueueItem.dispatch_subtask_id == previous,),
    )
    if item.archive_id:
        from backend.app.models.archive import PrintArchive

        await db.execute(
            update(PrintArchive)
            .where(
                PrintArchive.id == item.archive_id,
                PrintArchive.dispatched_queue_item_id == item.id,
                PrintArchive.subtask_id == previous,
            )
            .values(subtask_id=identity)
        )


async def observe_print(db: AsyncSession, printer_id: int, identity: str | None) -> tuple[PrintQueueItem | None, bool]:
    """Attach an observed active print, or create its external job atomically.

    The printer row serializes duplicate callbacks on SQLite and PostgreSQL.
    The existing unique active-printer index also fences scheduler dispatch.
    Never displace a different or unidentifiable active reservation.
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
        return item, confirmed
    held = await db.scalar(
        select(PrintQueueItem.id)
        .where(
            PrintQueueItem.printer_id == printer_id,
            PrintQueueItem.status.in_(ACTIVE_STATUSES),
        )
        .limit(1)
    )
    if held is not None:
        return None, False
    ended = await db.scalar(
        select(PrintQueueItem.id)
        .where(
            PrintQueueItem.printer_id == printer_id,
            PrintQueueItem.dispatch_subtask_id == identity,
            PrintQueueItem.status.in_(("completed", "failed", "cancelled")),
        )
        .limit(1)
    )
    if ended is not None:
        return None, False  # A duplicate/delayed start cannot revive a finished job.
    item = PrintQueueItem(
        printer_id=printer_id, status="printing", dispatch_subtask_id=identity, started_at=datetime.now(timezone.utc)
    )
    db.add(item)
    await db.flush()
    return item, False
