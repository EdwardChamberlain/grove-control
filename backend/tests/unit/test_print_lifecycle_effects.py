"""The registry must fence every effect behind the owning transaction's commit."""

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import select

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.print_lifecycle.effects import after_commit
from backend.app.services.queue_transitions import transition_queue_item
from backend.tests.unit.test_queue_transitions import make_item, sessions  # noqa: F401


@pytest.mark.parametrize("end", ["commit", "rollback", "close"])
@pytest.mark.parametrize("kind", ["start", "completion", "failure", "release"])
async def test_caller_effect_requires_commit_and_runs_once(sessions, end, kind):
    callback = AsyncMock(return_value="done")
    async with sessions() as db:
        await db.execute(select(1))
        effect = after_commit(db, (kind, 1), callback, delivery="caller")
        assert await effect.run() is None
        callback.assert_not_awaited()
        await getattr(db, end)()
    assert await effect.run() == ("done" if end == "commit" else None)
    await effect.run()
    assert callback.await_count == int(end == "commit")


async def test_replaced_effect_publishes_only_the_latest_projection(sessions):
    old, latest = Mock(), Mock()
    async with sessions() as db:
        await db.execute(select(1))
        after_commit(db, ("view", 1), old)
        after_commit(db, ("view", 1), latest)
        await db.commit()
        await db.commit()
    old.assert_not_called()
    latest.assert_called_once_with()


@pytest.mark.parametrize("commit", [True, False])
async def test_background_effect_reads_committed_data_in_its_own_session(sessions, commit):
    job_id = await make_item(sessions, "printing")
    observed = []
    done = asyncio.Event()

    async def observe():
        async with sessions() as db:
            observed.append((await db.get(PrintQueueItem, job_id)).status)
        done.set()

    async with sessions() as db:
        job = await db.get(PrintQueueItem, job_id)
        await transition_queue_item(db, job, "printing", "finished")
        after_commit(db, ("completion", job_id), observe, delivery="background")
        assert not done.is_set()
        if commit:
            await db.commit()
        else:
            await db.rollback()
    if commit:
        await asyncio.wait_for(done.wait(), 2)
    else:
        await asyncio.sleep(0)
    assert observed == (["finished"] if commit else [])
