"""The lifecycle's clock.

Lifecycle code reads time and sleeps only through this module, so tests can
replace it (``use``) and run soaks, acknowledgement windows and recovery
deadlines without waiting for them.
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...

    def monotonic(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def monotonic(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


_clock: Clock = SystemClock()


def use(clock: Clock) -> Clock:
    """Install ``clock`` and return the one it replaces."""
    global _clock
    previous, _clock = _clock, clock
    return previous


def now() -> datetime:
    """Aware UTC now."""
    return _clock.now()


def naive_now() -> datetime:
    """Naive UTC now, for comparisons with naive database timestamps."""
    return _clock.now().replace(tzinfo=None)


def monotonic() -> float:
    return _clock.monotonic()


async def sleep(seconds: float) -> None:
    await _clock.sleep(seconds)
