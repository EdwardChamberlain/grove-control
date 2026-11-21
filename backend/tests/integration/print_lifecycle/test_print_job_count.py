"""on_print_complete: counting finished jobs for print-job maintenance intervals (#337).

Runs the real callback against the test database. The counter is deliberately
independent of the print log, so these tests pin the cases where the two
differ: a job with no archive writes no log row but must still be counted.
"""

from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer

from .test_print_complete import _done, _start

pytestmark = pytest.mark.integration


async def _job_count(lifecycle, printer) -> int:
    return (await lifecycle.get(Printer, printer.id)).print_job_count


class TestPrintJobCounter:
    async def test_new_printer_starts_at_zero(self, lifecycle):
        printer = await lifecycle.make_printer()
        assert await _job_count(lifecycle, printer) == 0

    async def test_archived_job_is_counted_once(self, lifecycle):
        printer = await lifecycle.make_printer()
        await _start(lifecycle, printer)

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert await _job_count(lifecycle, printer) == 1
        assert len(await lifecycle.all(PrintLogEntry)) == 1

    @pytest.mark.parametrize("status", ["completed", "failed", "aborted", "cancelled"])
    async def test_every_terminal_status_counts_even_without_an_archive(self, lifecycle, status):
        """No archive means no print log row, but the machine still ran the job."""
        printer = await lifecycle.make_printer(auto_archive=False)

        await main.on_print_complete(printer.id, _done(status=status))
        await lifecycle.drain()

        assert await _job_count(lifecycle, printer) == 1
        assert await lifecycle.all(PrintLogEntry) == []
        assert await lifecycle.all(PrintArchive) == []

    async def test_consecutive_jobs_accumulate(self, lifecycle):
        printer = await lifecycle.make_printer(auto_archive=False)

        for subtask in ("First", "Second", "Third"):
            await main.on_print_complete(printer.id, _done(subtask=subtask))
            await lifecycle.drain()

        assert await _job_count(lifecycle, printer) == 3

    async def test_counts_are_per_printer(self, lifecycle):
        busy = await lifecycle.make_printer(auto_archive=False)
        idle = await lifecycle.make_printer(
            auto_archive=False, serial_number="00M09A000000902", ip_address="192.168.1.91", name="Idle"
        )

        await main.on_print_complete(busy.id, _done())
        await lifecycle.drain()

        assert await _job_count(lifecycle, busy) == 1
        assert await _job_count(lifecycle, idle) == 0

    async def test_event_without_filename_or_subtask_is_not_a_job(self, lifecycle):
        printer = await lifecycle.make_printer(auto_archive=False)

        await main.on_print_complete(printer.id, {"status": "completed", "filename": "", "subtask_name": ""})
        await lifecycle.drain()

        assert await _job_count(lifecycle, printer) == 0

    async def test_clearing_the_print_log_does_not_reset_the_count(self, lifecycle):
        from sqlalchemy import delete

        printer = await lifecycle.make_printer()
        await _start(lifecycle, printer)
        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        async with lifecycle.session() as db:
            await db.execute(delete(PrintLogEntry))
            await db.commit()

        assert await lifecycle.all(PrintLogEntry) == []
        assert await _job_count(lifecycle, printer) == 1

    async def test_counter_failure_does_not_break_completion(self, lifecycle):
        """A failed increment is logged, never allowed to leave the archive stuck in 'printing'."""
        printer = await lifecycle.make_printer()
        archive = await _start(lifecycle, printer)

        with patch(
            "backend.app.services.print_log.increment_print_job_count",
            new=AsyncMock(side_effect=RuntimeError("database exploded")),
        ):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        assert (await lifecycle.get(PrintArchive, archive.id)).status == "completed"
        assert await _job_count(lifecycle, printer) == 0
