"""Background sweepers survive errors, and the VP bridge survives a failed import.

These error paths used to be marked ``pragma: no cover - defensive``. They run
fine under test, so they are tested instead (CLAUDE.md, "Coverage exclusions").
"""

import asyncio
import importlib
import logging
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.virtual_printer import mqtt_bridge


@pytest.mark.parametrize(
    ("module_path", "service_name", "session_target", "log_text"),
    [
        (
            "backend.app.services.archive_purge",
            "archive_purge_service",
            "backend.app.core.database.async_session",
            "Error in archive auto-purge sweeper",
        ),
        (
            "backend.app.services.library_trash",
            "library_trash_service",
            "backend.app.services.library_trash.async_session",
            "Error in library trash sweeper",
        ),
        (
            "backend.app.services.temporary_files",
            "temporary_files_service",
            "backend.app.services.temporary_files.async_session",
            "Error in Temporary Files sweeper",
        ),
    ],
)
async def test_sweeper_logs_error_backs_off_and_keeps_running(
    module_path, service_name, session_target, log_text, caplog
):
    module = importlib.import_module(module_path)
    service = getattr(module, service_name)

    # First sweep fails; the loop should log, back off 60s, then go round
    # again (where the next sleep is cancelled, ending the loop cleanly).
    sleep = AsyncMock(side_effect=[None, None, asyncio.CancelledError()])
    failing_session = MagicMock(side_effect=RuntimeError("database is locked"))

    with (
        patch.object(module.asyncio, "sleep", sleep),
        patch(session_target, failing_session),
        caplog.at_level(logging.ERROR, logger=module.__name__),
    ):
        await asyncio.wait_for(service._scheduler_loop(), timeout=5)

    assert failing_session.call_count == 1
    assert [c.args[0] for c in sleep.await_args_list] == [
        service._check_interval,
        60,
        service._check_interval,
    ]
    assert f"{log_text}: database is locked" in caplog.text


def test_bridge_skips_interface_lookup_when_network_utils_cannot_import():
    with patch.dict(sys.modules, {"backend.app.services.network_utils": None}):
        assert mqtt_bridge._resolve_host_interface_for_target("192.168.1.50") is None
