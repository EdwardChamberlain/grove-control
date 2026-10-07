"""Queued (#204): a job waits in its queue until a printer is selected for it.

Enter: ``create_job`` adds every new job, from the Queue, Files, a webhook, a
virtual printer or Retry. Wait: each scheduler pass, printer selection picks a
printer and tray mapping in memory; nothing is written to the job. Exit: a
dispatch worker holds the selected printer (preheating or dispatching), or a
person cancels the job (unsuccessful). Recover: the job is durable, and startup
releases the previous process's worker claims.
"""

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Literal

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.services.filament_requirements import build_queue_filament_overrides, extract_filament_requirements


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
    values = {}
    if variants:
        # The scheduler orders a job before its printer is known, by its shortest candidate.
        estimates = [variant["print_time_seconds"] for variant in variants if variant.get("print_time_seconds")]
        values["print_time_seconds"] = min(estimates) if estimates else None
    models = {model for model in (jobs[0].get("target_model"), *(v["target_model"] for v in variants)) if model}
    first = await _place(db, jobs[0].get("printer_id"), models, len(jobs), at)
    created = []
    for offset, job in enumerate(jobs):
        created.append(PrintQueueItem(**{**job, **values}, status="queued", position=first + offset))
        created[-1].variants.extend(PrintQueueVariant(**variant) for variant in variants)
        db.add(created[-1])
    await db.flush()
    from backend.app.services.lifecycle import effects

    effects.publish_queue_work_changed(db)
    return created


async def _place(
    db: AsyncSession, printer_id: int | None, models: set[str], quantity: int, at: int | str | None
) -> int:
    """The first position for new jobs, taken under a lock on their queue."""
    if db.get_bind().dialect.name == "postgresql":
        # SQLite serializes writes; an empty queue has no rows for PostgreSQL to lock.
        await db.execute(text("SELECT pg_advisory_xact_lock(1625, :k)"), {"k": printer_id or 0})
    printer = PrintQueueItem.printer_id.is_(None) if printer_id is None else PrintQueueItem.printer_id == printer_id
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
