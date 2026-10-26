"""Regression tests for print-time metadata on no-archive notifications."""

import pytest

from backend.app import main
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem

pytestmark = pytest.mark.integration


def _done(**extra):
    data = {"status": "completed", "filename": "/data/Metadata/plate_1.gcode", "subtask_name": "Benchy"}
    data.update(extra)
    return data


async def _complete_no_archive(lifecycle, metadata, *, remaining_time=None):
    printer = await lifecycle.make_printer(auto_archive=False)
    library_file = await lifecycle.add(
        LibraryFile(
            filename="Benchy.3mf",
            file_path="library/Benchy.3mf",
            file_type="3mf",
            file_size=10,
            file_metadata=metadata,
        )
    )
    await lifecycle.add(
        PrintQueueItem(printer_id=printer.id, status="printing", position=1, library_file_id=library_file.id)
    )
    await main.on_print_complete(printer.id, _done(remaining_time=remaining_time))
    await lifecycle.drain()
    return lifecycle.notifications.on_print_complete.await_args


async def test_uses_library_file_print_time_metadata(lifecycle):
    notification = await _complete_no_archive(lifecycle, {"print_time_seconds": 4321}, remaining_time=900)
    assert notification.kwargs["archive_data"]["print_time_seconds"] == 4321


@pytest.mark.parametrize("metadata", [{}, {"print_time_seconds": "not-a-number"}])
async def test_malformed_or_missing_metadata_keeps_notification_and_fallback(lifecycle, metadata):
    notification = await _complete_no_archive(lifecycle, metadata, remaining_time=900)
    assert notification is not None
    assert notification.kwargs["archive_data"]["print_time_seconds"] == 900
