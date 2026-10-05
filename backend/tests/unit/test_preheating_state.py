"""Transaction boundaries of the preheating state entry and exit."""

from unittest.mock import call

import pytest
from sqlalchemy import event, inspect, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.lifecycle.engine import transition_queue_item
from backend.tests.unit.test_chamber_heat_soak import soak  # noqa: F401


async def test_failed_reservation_commit_never_enters_heating(soak):
    def fail_commit(_connection):
        raise OperationalError("COMMIT", {}, RuntimeError("disk unavailable"))

    engine = soak.engine.sync_engine
    event.listen(engine, "commit", fail_commit)
    try:
        with pytest.raises(OperationalError):
            await soak.service.stage(soak.db, soak.item)
    finally:
        event.remove(engine, "commit", fail_commit)
    await soak.db.rollback()
    await soak.db.refresh(soak.item)
    assert soak.item.status == "queued"
    soak.client.set_bed_temperature.assert_not_called()
    soak.client.set_chamber_temperature.assert_not_called()
    soak.client.set_airduct_mode.assert_not_called()


async def test_stop_after_reservation_commit_prevents_heater_entry(soak, monkeypatch):
    commit = soak.db.commit

    async def stop_after_commit():
        await commit()
        async with AsyncSession(soak.engine, expire_on_commit=False) as user:
            current = await user.get(PrintQueueItem, soak.item.id)
            await transition_queue_item(user, current, "preheating", "cancelled", action="cancel")
            await user.commit()

    monkeypatch.setattr(soak.db, "commit", stop_after_commit)
    assert not await soak.service.stage(soak.db, soak.item)
    await soak.wait_effects()
    await soak.db.refresh(soak.item)
    assert soak.item.status == "cancelled"
    assert soak.item.preheat_owner is None
    assert call(60) not in soak.client.set_bed_temperature.call_args_list
    assert call(60) not in soak.client.set_chamber_temperature.call_args_list
    assert call("heating") not in soak.client.set_airduct_mode.call_args_list


async def test_rolled_back_exit_preserves_the_timer_and_printer_view(soak):
    assert await soak.service.stage(soak.db, soak.item)
    started = soak.item.preheat_started_at
    soak.client.reset_mock()
    await transition_queue_item(soak.db, soak.item, "preheating", "failed")
    assert soak.state.preheating
    await soak.db.rollback()
    await soak.db.refresh(soak.item)
    await soak.db.refresh(soak.printer)
    assert (soak.item.status, soak.item.preheat_owner, soak.item.preheat_started_at) == (
        "preheating",
        soak.service.owner,
        started,
    )
    assert soak.state.preheating
    assert not soak.printer.heat_soak_shutdown_pending
    await soak.wait_effects()
    soak.client.set_bed_temperature.assert_not_called()
    soak.client.set_chamber_temperature.assert_not_called()


async def test_other_states_do_not_load_deferred_preheating_options(soak):
    soak.db.expunge(soak.item)
    item = await soak.db.scalar(select(PrintQueueItem).options(defer(PrintQueueItem.chamber_heat_soak)))
    assert "chamber_heat_soak" in inspect(item).unloaded
    await transition_queue_item(soak.db, item, "queued", "dispatching")
    await soak.db.commit()
    assert item.status == "dispatching"
    soak.client.set_bed_temperature.assert_not_called()
