from types import SimpleNamespace
from unittest.mock import AsyncMock

from backend.app.services.lifecycle import deadlines


def test_dispatch_ready_deadline_uses_the_active_dispatcher():
    ready_due = AsyncMock()

    handlers = deadlines._handlers(SimpleNamespace(ready_due=ready_due))

    assert handlers["dispatch_ready"] is ready_due
