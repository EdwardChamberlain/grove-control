"""Only one Grove process runs on a database."""

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.services.lifecycle.lease import Lease, LeaseHeld


async def test_a_second_process_cannot_take_the_database(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'grove.db'}")
    first, second = Lease(), Lease()
    await first.acquire(engine)
    try:
        with pytest.raises(LeaseHeld):
            await second.acquire(engine)
    finally:
        await first.release()

    await second.acquire(engine)  # Released on shutdown, so the next start succeeds.
    await second.release()
    await engine.dispose()
