"""Regression coverage for the active-printer reservation migration."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from backend.app.core.database import Base, _ensure_active_queue_printer_reservation
from backend.app.models.print_queue import PrintQueueItem


@pytest.mark.asyncio
async def test_duplicate_active_rows_are_recovered_before_unique_index_creation():
    """Historical optimistic rows must not make an upgrade fail at startup."""
    import backend.app.models  # noqa: F401 - populate Base.metadata

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        now = datetime.now(timezone.utc)
        async with AsyncSession(engine) as session:
            session.add_all(
                [
                    PrintQueueItem(id=1, printer_id=42, status="printing", started_at=now - timedelta(minutes=1)),
                    PrintQueueItem(id=2, printer_id=42, status="dispatching", dispatched_at=now),
                ]
            )
            await session.commit()

        async with engine.begin() as conn:
            await _ensure_active_queue_printer_reservation(conn)

        async with AsyncSession(engine) as session:
            rows = list(
                (await session.execute(select(PrintQueueItem).where(PrintQueueItem.printer_id == 42))).scalars()
            )
            assert {row.status for row in rows} == {"printing", "failed"}
            recovered = next(row for row in rows if row.status == "failed")
            assert recovered.error_message and "duplicate active queue reservation" in recovered.error_message

            session.add(PrintQueueItem(id=3, printer_id=42, status="dispatching"))
            with pytest.raises(IntegrityError):
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()
