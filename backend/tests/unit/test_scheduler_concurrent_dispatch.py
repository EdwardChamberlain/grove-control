"""Regression coverage for issue #63's bounded fleet dispatch pool."""

import asyncio
from unittest.mock import patch

import pytest

from backend.app.schemas.settings import AppSettings
from backend.app.services.print_scheduler import PrintScheduler


async def _drain(scheduler: PrintScheduler) -> None:
    tasks = [task for task, _printer_id in scheduler._inflight.values()]
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

    async def dispatch(item_id: int, _selected_printer_id: int | None = None) -> None:
        nonlocal peak
        entered.append(item_id)
        peak = max(peak, len(entered))
        if len(entered) == 2:
            ready.set()
        await release.wait()
        entered.remove(item_id)

    with patch(
        "backend.app.services.print_scheduler.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler._dispatch_one = dispatch  # type: ignore[method-assign]
        scheduler._launch_uploads([1, 2], {1: 101, 2: 102}, limit=2)
        await asyncio.wait_for(ready.wait(), timeout=1)
        assert peak == 2
        assert set(scheduler._inflight) == {1, 2}
        release.set()
        await _drain(scheduler)

    assert not scheduler._inflight


@pytest.mark.asyncio
async def test_pool_cap_refills_after_a_slot_is_freed():
    scheduler = PrintScheduler()
    release = asyncio.Event()
    started: list[int] = []

    async def dispatch(item_id: int, _selected_printer_id: int | None = None) -> None:
        started.append(item_id)
        await release.wait()

    with patch(
        "backend.app.services.print_scheduler.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler._dispatch_one = dispatch  # type: ignore[method-assign]
        scheduler._launch_uploads([1, 2, 3], {1: 101, 2: 102, 3: 103}, limit=2)
        await asyncio.sleep(0)
        assert set(scheduler._inflight) == {1, 2}
        assert started == [1, 2]

        release.set()
        await _drain(scheduler)
        release = asyncio.Event()

        scheduler._launch_uploads([3], {3: 103}, limit=2)
        await asyncio.sleep(0)
        assert set(scheduler._inflight) == {3}
        assert started == [1, 2, 3]
        release.set()
        await _drain(scheduler)


@pytest.mark.asyncio
async def test_cancellation_releases_pool_slot():
    scheduler = PrintScheduler()
    release = asyncio.Event()

    async def dispatch(_item_id: int, _selected_printer_id: int | None = None) -> None:
        await release.wait()

    with patch(
        "backend.app.services.print_scheduler.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler._dispatch_one = dispatch  # type: ignore[method-assign]
        scheduler._launch_uploads([1], {1: 101}, limit=1)
        task = scheduler._inflight[1][0]
        task.cancel()
        await _drain(scheduler)
        assert not scheduler._inflight

        scheduler._launch_uploads([2], {2: 102}, limit=1)
        assert set(scheduler._inflight) == {2}
        scheduler._inflight[2][0].cancel()
        await _drain(scheduler)


@pytest.mark.asyncio
async def test_same_printer_is_reserved_once_even_if_selection_repeats():
    scheduler = PrintScheduler()
    release = asyncio.Event()

    async def dispatch(_item_id: int, _selected_printer_id: int | None = None) -> None:
        await release.wait()

    with patch(
        "backend.app.services.print_scheduler.spawn_background_task",
        side_effect=lambda coro, *, name=None: asyncio.create_task(coro, name=name),
    ):
        scheduler._dispatch_one = dispatch  # type: ignore[method-assign]
        scheduler._launch_uploads([1, 2], {1: 101, 2: 101}, limit=2)
        await asyncio.sleep(0)
        assert set(scheduler._inflight) == {1}
        release.set()
        await _drain(scheduler)


def test_concurrency_setting_defaults_to_legacy_serial_behavior():
    assert AppSettings().queue_max_concurrent_uploads == 1
