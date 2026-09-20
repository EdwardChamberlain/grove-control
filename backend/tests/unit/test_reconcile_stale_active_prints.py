"""Reconnect reconciliation tests for durable PrintJobs."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _state(state: str, *, connected: bool = True, subtask_id: str = ""):
    return SimpleNamespace(
        state=state,
        connected=connected,
        raw_data={"subtask_id": subtask_id} if subtask_id else {},
        subtask_id=subtask_id,
        gcode_file="/model.3mf",
    )


@pytest.mark.asyncio
async def test_reconnect_reconciliation_requires_durable_task_identity():
    from backend.app.main import reconcile_stale_active_prints

    missing_identity = SimpleNamespace(job_id="job-1", dispatch_subtask_id=None)
    result = MagicMock()
    result.scalars.return_value.all.return_value = [missing_identity]
    session = AsyncMock()
    session.execute.return_value = result

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch("backend.app.main.async_session") as session_factory,
    ):
        manager.get_status.return_value = _state("IDLE")
        session_factory.return_value.__aenter__.return_value = session
        assert await reconcile_stale_active_prints(1) == 0


@pytest.mark.asyncio
async def test_reconnect_reconciliation_synthesises_event_for_exact_job_task():
    from backend.app.main import reconcile_stale_active_prints

    job = SimpleNamespace(job_id="job-1", dispatch_subtask_id="task-1")
    result = MagicMock()
    result.scalars.return_value.all.return_value = [job]
    session = AsyncMock()
    session.execute.return_value = result

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch("backend.app.main.async_session") as session_factory,
        patch("backend.app.main.on_print_complete", new=AsyncMock()) as complete,
    ):
        manager.get_status.side_effect = [_state("IDLE"), _state("IDLE")]
        manager.get_connection_epoch.return_value = "epoch-1"
        session_factory.return_value.__aenter__.return_value = session
        assert await reconcile_stale_active_prints(1) == 1

    payload = complete.await_args.args[1]
    assert payload["subtask_id"] == "task-1"
    assert payload["_connection_epoch"] == "epoch-1"
    assert payload["_reconciled"] is True


@pytest.mark.asyncio
async def test_reconnect_reconciliation_does_not_complete_when_printer_is_active():
    from backend.app.main import reconcile_stale_active_prints

    job = SimpleNamespace(job_id="job-1", dispatch_subtask_id="task-1")
    result = MagicMock()
    result.scalars.return_value.all.return_value = [job]
    session = AsyncMock()
    session.execute.return_value = result

    with (
        patch("backend.app.main.printer_manager") as manager,
        patch("backend.app.main.async_session") as session_factory,
        patch("backend.app.main.on_print_complete", new=AsyncMock()) as complete,
    ):
        manager.get_status.return_value = _state("RUNNING", subtask_id="task-1")
        session_factory.return_value.__aenter__.return_value = session
        assert await reconcile_stale_active_prints(1) == 0
        complete.assert_not_awaited()
