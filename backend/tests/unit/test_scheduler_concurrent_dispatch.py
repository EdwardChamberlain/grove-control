"""Regression coverage for issue #63's bounded fleet dispatch pool."""

import asyncio
from unittest.mock import patch

import pytest

from backend.app.schemas.settings import AppSettings
from backend.app.services.lifecycle.queued import _DispatchBinding
from backend.app.services.print_scheduler import PrintScheduler


def _bindings(printers: dict[int, int]) -> dict[int, _DispatchBinding]:
    return {item_id: _DispatchBinding(printer_id, None, unassigned=False) for item_id, printer_id in printers.items()}


async def _drain(scheduler: PrintScheduler) -> None:
    tasks = [task for task, _printer_id in scheduler.workers.inflight.values()]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    # Done callbacks remove completed tasks on the next event-loop turn.
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_different_printers_dispatch_concurrently():
    scheduler = PrintScheduler()
    entered: list[int] = []
    ready = asyncio.Event()
    release = asyncio.Event()
    peak = 0

    async def dispatch(item_id: int, _binding: _DispatchBinding) -> None:
        nonlocal peak
        entered.append(item_id)
        peak = max(peak, len(entered))
        if len(entered) == 2:
            ready.set()
        await release.wait()
        entered.remove(item_id)

    with patch(
        "backend.app.services.lifecycle.queued.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler.workers._work = dispatch  # type: ignore[method-assign]
        scheduler.workers.launch(_bindings({1: 101, 2: 102}), 2)
        await asyncio.wait_for(ready.wait(), timeout=1)
        assert peak == 2
        assert set(scheduler.workers.inflight) == {1, 2}
        release.set()
        await _drain(scheduler)

    assert not scheduler.workers.inflight


@pytest.mark.asyncio
async def test_pool_cap_refills_after_a_slot_is_freed():
    scheduler = PrintScheduler()
    release = asyncio.Event()
    started: list[int] = []

    async def dispatch(item_id: int, _binding: _DispatchBinding) -> None:
        started.append(item_id)
        await release.wait()

    with patch(
        "backend.app.services.lifecycle.queued.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler.workers._work = dispatch  # type: ignore[method-assign]
        scheduler.workers.launch(_bindings({1: 101, 2: 102, 3: 103}), 2)
        await asyncio.sleep(0)
        assert set(scheduler.workers.inflight) == {1, 2}
        assert started == [1, 2]

        release.set()
        await _drain(scheduler)
        release = asyncio.Event()

        scheduler.workers.launch(_bindings({3: 103}), 2)
        await asyncio.sleep(0)
        assert set(scheduler.workers.inflight) == {3}
        assert started == [1, 2, 3]
        release.set()
        await _drain(scheduler)


@pytest.mark.asyncio
async def test_cancellation_releases_pool_slot():
    scheduler = PrintScheduler()
    release = asyncio.Event()

    async def dispatch(_item_id: int, _binding: _DispatchBinding) -> None:
        await release.wait()

    with patch(
        "backend.app.services.lifecycle.queued.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler.workers._work = dispatch  # type: ignore[method-assign]
        scheduler.workers.launch(_bindings({1: 101}), 1)
        task = scheduler.workers.inflight[1][0]
        task.cancel()
        await _drain(scheduler)
        assert not scheduler.workers.inflight

        scheduler.workers.launch(_bindings({2: 102}), 1)
        assert set(scheduler.workers.inflight) == {2}
        scheduler.workers.inflight[2][0].cancel()
        await _drain(scheduler)


@pytest.mark.asyncio
async def test_same_printer_is_reserved_once_even_if_selection_repeats():
    scheduler = PrintScheduler()
    release = asyncio.Event()

    async def dispatch(_item_id: int, _binding: _DispatchBinding) -> None:
        await release.wait()

    with patch(
        "backend.app.services.lifecycle.queued.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler.workers._work = dispatch  # type: ignore[method-assign]
        scheduler.workers.launch(_bindings({1: 101, 2: 101}), 2)
        await asyncio.sleep(0)
        assert set(scheduler.workers.inflight) == {1}
        release.set()
        await _drain(scheduler)


def test_concurrency_setting_defaults_to_legacy_serial_behavior():
    assert AppSettings().queue_max_concurrent_uploads == 1
