"""Printing (#204): printing and paused, until the print ends. Stage 6 moves adoption and start effects here."""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.user import User
from backend.app.services.lifecycle.preheating import shut_down_inherited


async def owner_of(db: AsyncSession, item: PrintQueueItem) -> tuple[int, str] | None:
    """The job's owner, whom its completion credits; None for an ownerless job."""
    owner = await db.get(User, item.created_by_id) if item.created_by_id else None
    return (owner.id, owner.username) if owner else None


async def on_exit(change, row) -> None:
    """Exit: a failed or stopped print shuts down the heaters a heat soak left on."""
    await shut_down_inherited(change, row)
