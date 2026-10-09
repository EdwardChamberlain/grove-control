"""Job attribution for queue, MQTT and recovery (#194 stage 2).

Names are display data. Only an observed identity can select a job. Local
prints with no firmware ID get a session ID from the MQTT client; after an
application restart that ID cannot prove continuity, so the old job stays put.
"""

from datetime import timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import ACTIVE_STATUSES, PrintQueueItem
from backend.app.services.lifecycle import clock


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


def printer_active(printer_id: int | None) -> bool:
    """Fresh telemetry shows a print running on this printer."""
    from backend.app.services.printer_manager import printer_manager

    live = printer_manager.get_status(printer_id) if printer_id is not None else None
    return bool(
        live
        and live.connected
        and getattr(live, "job_telemetry_ready", True)
        and live.state in ("PREPARE", "SLICING", "RUNNING", "PAUSE")
    )


def needs_dispatch_resolution(item: PrintQueueItem) -> bool:
    from backend.app.services.lifecycle.queued import in_flight

    # The reservation covers preparation too. A live upload/Archive worker
    # has not yet handed the attempt to confirmation; it cannot be resolved
    # as printing (or failed) while that worker may still send the command.
    if (
        item.status != "dispatching"
        or in_flight(item.id)
        or not normalize_id(item.dispatch_subtask_id)
        or item.dispatched_at is None
    ):
        return False
    sent = item.dispatched_at
    return (clock.now() - sent.replace(tzinfo=timezone.utc)).total_seconds() >= 270


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
