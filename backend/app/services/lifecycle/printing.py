"""Printing (#204): printing and paused, until the print ends. Stage 6 moves adoption and start effects here."""

from backend.app.services.lifecycle.preheating import shut_down_inherited


async def on_exit(change, row) -> None:
    """Exit: a failed or stopped print shuts down the heaters a heat soak left on."""
    await shut_down_inherited(change, row)
