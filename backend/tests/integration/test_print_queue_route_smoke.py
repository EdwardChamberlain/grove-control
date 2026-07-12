"""Route-level smoke coverage for queue grouping and reorder flows."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select


@pytest.fixture
async def queue_item_factory(db_session, printer_factory, archive_factory):
    counter = 0

    async def _create_queue_item(**kwargs):
        nonlocal counter
        counter += 1

        from backend.app.models.print_queue import PrintQueueItem

        printer = await printer_factory()
        archive = await archive_factory(printer.id, content_hash=f"queue-route-smoke-{counter}")

        defaults = {
            "printer_id": printer.id,
            "archive_id": archive.id,
            "status": "pending",
            "position": counter,
        }
        defaults.update(kwargs)

        item = PrintQueueItem(**defaults)
        db_session.add(item)
        await db_session.commit()
        await db_session.refresh(item)
        return item

    return _create_queue_item


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queue_batch_create_assigns_pending_items(async_client: AsyncClient, queue_item_factory):
    first = await queue_item_factory(position=1)
    second = await queue_item_factory(position=2)
    completed = await queue_item_factory(position=3, status="completed")

    response = await async_client.post(
        "/api/v1/queue/batches",
        json={"name": "Weekend batch", "item_ids": [first.id, second.id, completed.id]},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Weekend batch"
    assert data["quantity"] == 2

    items = await async_client.get("/api/v1/queue/")
    assert items.status_code == 200
    by_id = {item["id"]: item for item in items.json()}
    assert by_id[first.id]["batch_id"] == data["id"]
    assert by_id[second.id]["batch_id"] == data["id"]
    assert by_id[completed.id]["batch_id"] is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queue_reorder_updates_only_pending_items(async_client: AsyncClient, queue_item_factory, db_session):
    first = await queue_item_factory(position=1)
    second = await queue_item_factory(position=2)
    completed = await queue_item_factory(position=3, status="completed")
    first_id = first.id
    second_id = second.id
    completed_id = completed.id

    response = await async_client.post(
        "/api/v1/queue/reorder",
        json={
            "items": [
                {"id": first_id, "position": 20},
                {"id": second_id, "position": 10},
                {"id": completed_id, "position": 1},
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["message"] == "Reordered 3 items"

    from backend.app.models.print_queue import PrintQueueItem

    db_session.expire_all()
    result = await db_session.execute(
        select(PrintQueueItem)
        .where(PrintQueueItem.id.in_([first_id, second_id, completed_id]))
        .execution_options(populate_existing=True)
    )
    positions = {item.id: item.position for item in result.scalars()}
    assert positions[first_id] == 20
    assert positions[second_id] == 10
    assert positions[completed_id] == 3


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queue_batch_requires_nonblank_name(async_client: AsyncClient, queue_item_factory):
    item = await queue_item_factory()

    response = await async_client.post(
        "/api/v1/queue/batches",
        json={"name": "   ", "item_ids": [item.id]},
    )

    assert response.status_code == 400
    assert "Batch name is required" in response.json()["detail"]
