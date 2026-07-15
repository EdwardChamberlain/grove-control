"""Regression coverage for support-bundle HTTP exception logging."""

from __future__ import annotations

import logging

import pytest
from starlette.requests import Request

from backend.app.main import unhandled_http_exception_logger


@pytest.mark.asyncio
async def test_unhandled_http_exception_logs_method_path_and_traceback(caplog):
    """Unexpected endpoint failures must be actionable from bambuddy.log."""
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "path": "/api/v1/queue/",
            "raw_path": b"/api/v1/queue/",
            "query_string": b"secret=must-not-be-logged",
            "headers": [],
            "server": ("testserver", 80),
            "client": ("testclient", 12345),
        }
    )

    async def failing_endpoint(_request):
        raise RuntimeError("missing queue column")

    with (
        caplog.at_level(logging.ERROR, logger="backend.app.main"),
        pytest.raises(RuntimeError, match="missing queue column"),
    ):
        await unhandled_http_exception_logger(request, failing_endpoint)

    records = [record for record in caplog.records if "Unhandled HTTP request failure" in record.message]
    assert len(records) == 1
    assert "POST /api/v1/queue/" in records[0].message
    assert records[0].exc_info is not None
    assert "secret=must-not-be-logged" not in caplog.text
