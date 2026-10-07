"""Final (#204): release queue-only sources after the job ends; Retry creates a new job."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.services.lifecycle.engine import transition_queue_item


async def end(db: AsyncSession, item: PrintQueueItem, action: str, **values) -> None:
    """Enter from ``item``'s holding state, for ``action``: only a finished print ends successful."""
    status = "successful" if item.status == "finished" else "unsuccessful"
    await transition_queue_item(db, item, item.status, status, action=action, values=values)


async def on_enter(change, row) -> None:
    """Enter: release the job's Queue-only sources once nothing else needs them."""
    from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused

    variants = select(PrintQueueVariant.library_file_id).where(PrintQueueVariant.queue_item_id == change.item_id)
    source_ids = {*await change.db.scalars(variants), row.library_file_id}
    for source_id in sorted(source_ids - {None}):
        await remove_queue_only_source_if_unused(change.db, source_id)
