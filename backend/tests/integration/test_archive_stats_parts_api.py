"""Archive stats: successful parts totals (#286).

Parts sum the linked archive's quantity over completed runs. A run whose
archive was deleted, or whose quantity is below 1, counts as one part.
"""

from datetime import datetime, timezone

import pytest
from httpx import AsyncClient

from backend.app.models.print_log import PrintLogEntry

pytestmark = pytest.mark.integration


async def _add_run(db_session, archive, status="completed", created_at=None, created_by_id=None, archive_id="auto"):
    db_session.add(
        PrintLogEntry(
            archive_id=archive.id if archive_id == "auto" else archive_id,
            printer_id=archive.printer_id,
            status=status,
            created_at=created_at or datetime(2026, 5, 1, 11, 0, tzinfo=timezone.utc),
            created_by_id=created_by_id,
        )
    )
    await db_session.commit()


async def test_stats_successful_parts_sums_archive_quantity(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    a4 = await archive_factory(printer.id, quantity=4, with_run=False)
    a1 = await archive_factory(printer.id, quantity=1, with_run=False)
    await _add_run(db_session, a4)
    await _add_run(db_session, a1)

    data = (await async_client.get("/api/v1/archives/stats")).json()
    assert data["successful_parts"] == 5
    assert data["successful_prints"] == 2


async def test_stats_successful_parts_ignores_non_completed_runs(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, quantity=4, with_run=False)
    for status in ("failed", "aborted", "stopped", "cancelled", "skipped"):
        await _add_run(db_session, archive, status=status)

    data = (await async_client.get("/api/v1/archives/stats")).json()
    assert data["successful_parts"] == 0
    assert data["successful_prints"] == 0


async def test_stats_successful_parts_unknown_quantity_counts_one(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    base = await archive_factory(printer.id, quantity=3, with_run=False)
    # quantity is NOT NULL on fresh databases, so a NULL can't be created here.
    # Bad manual edits show up as 0 or below instead, and must count as 1.
    negative_qty = await archive_factory(printer.id, quantity=-2, with_run=False)
    zero_qty = await archive_factory(printer.id, quantity=0, with_run=False)

    await _add_run(db_session, base, archive_id=None)  # archive deleted
    await _add_run(db_session, negative_qty)
    await _add_run(db_session, zero_qty)

    data = (await async_client.get("/api/v1/archives/stats")).json()
    assert data["successful_parts"] == 3
    assert data["successful_prints"] == 3


async def test_stats_successful_parts_counts_reprints_again(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, quantity=4, with_run=False)
    await _add_run(db_session, archive)
    await _add_run(db_session, archive)

    data = (await async_client.get("/api/v1/archives/stats")).json()
    assert data["successful_parts"] == 8
    assert data["successful_prints"] == 2


async def test_stats_successful_parts_respects_date_range(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, quantity=4, with_run=False)
    await _add_run(db_session, archive, created_at=datetime(2026, 4, 1, 10, 0, tzinfo=timezone.utc))
    await _add_run(db_session, archive, created_at=datetime(2026, 5, 10, 10, 0, tzinfo=timezone.utc))

    resp = await async_client.get("/api/v1/archives/stats?date_from=2026-05-01&date_to=2026-05-31")
    assert resp.json()["successful_parts"] == 4
    assert (await async_client.get("/api/v1/archives/stats")).json()["successful_parts"] == 8


async def test_stats_successful_parts_respects_user_filter(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    from backend.app.models.user import User

    user = User(username="maker", password_hash="x", role="user")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    printer = await printer_factory()
    archive = await archive_factory(printer.id, quantity=4, with_run=False)
    await _add_run(db_session, archive, created_by_id=user.id)
    await _add_run(db_session, archive)

    assert (await async_client.get(f"/api/v1/archives/stats?created_by_id={user.id}")).json()["successful_parts"] == 4
    assert (await async_client.get("/api/v1/archives/stats?created_by_id=-1")).json()["successful_parts"] == 4
    assert (await async_client.get("/api/v1/archives/stats")).json()["successful_parts"] == 8


async def test_stats_successful_parts_empty_database(async_client: AsyncClient):
    data = (await async_client.get("/api/v1/archives/stats")).json()
    assert data["successful_parts"] == 0
