"""Regression coverage for local inventory gross-weight synchronization."""

import pytest
from httpx import AsyncClient

from backend.app.models.spool import Spool


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sync_inventory_spool_weight_updates_usage_and_scale_metadata(
    async_client: AsyncClient,
    db_session,
):
    spool = Spool(
        material="PLA",
        subtype="Basic",
        label_weight=1000,
        core_weight=250,
        weight_used=0,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)

    response = await async_client.patch(
        f"/api/v1/inventory/spools/{spool.id}/weight",
        json={"weight_grams": 750},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "weight_used": 500.0}

    await db_session.refresh(spool)
    assert spool.last_scale_weight == 750
    assert spool.last_weighed_at is not None
    assert spool.weight_used == 500.0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sync_inventory_spool_weight_returns_404_for_unknown_spool(
    async_client: AsyncClient,
):
    response = await async_client.patch(
        "/api/v1/inventory/spools/999999/weight",
        json={"weight_grams": 750},
    )

    assert response.status_code == 404
