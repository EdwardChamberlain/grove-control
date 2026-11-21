"""on_print_complete: counting filament changes for filament-change maintenance intervals (#337).

Runs the real callback against the test database with real sliced plates from
``tests/_fixtures/threemf``. A run's changes are the initial load plus every change
defined in its sliced file; a run that stopped early only counts the loads it reached.
"""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer

from .test_print_complete import _done

pytestmark = pytest.mark.integration

FIXTURES = Path(__file__).resolve().parents[2] / "_fixtures" / "threemf"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())["files"]


async def _start_with(lifecycle, printer, fixture: str, *, subtask: str = "Benchy"):
    """Run a real print start for a real sliced plate; returns the newest archive."""
    lifecycle.storage.files[f"/{subtask}.gcode.3mf"] = (FIXTURES / fixture).read_bytes()
    await main.on_print_start(printer.id, {"filename": "/data/Metadata/plate_1.gcode", "subtask_name": subtask})
    await lifecycle.drain()
    archive = max(await lifecycle.all(PrintArchive), key=lambda a: a.id)
    lifecycle.ws.reset_mock()
    lifecycle.notifications.reset_mock()
    lifecycle.notifications._get_providers_for_event.return_value = []
    return archive


async def _counts(lifecycle, printer) -> tuple[int, int]:
    refreshed = await lifecycle.get(Printer, printer.id)
    return refreshed.filament_change_count, refreshed.print_job_count


class TestCompletedRuns:
    @pytest.mark.parametrize("fixture", sorted(MANIFEST))
    async def test_completed_run_counts_the_initial_load_and_every_change(self, lifecycle, fixture):
        printer = await lifecycle.make_printer()
        await _start_with(lifecycle, printer, fixture)

        await main.on_print_complete(printer.id, _done(status="completed"))
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (MANIFEST[fixture]["expected_loads"], 1)
        assert len(await lifecycle.all(PrintLogEntry)) == 1

    async def test_changes_accumulate_across_jobs(self, lifecycle):
        printer = await lifecycle.make_printer()
        for subtask, fixture in (("First", "cylinder_2_changes.3mf"), ("Second", "cylinder_1_change.3mf")):
            await _start_with(lifecycle, printer, fixture, subtask=subtask)
            await main.on_print_complete(printer.id, _done(subtask=subtask))
            await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (3 + 2, 2)

    async def test_changes_are_per_printer(self, lifecycle):
        busy = await lifecycle.make_printer()
        idle = await lifecycle.make_printer(
            serial_number="00M09A000000902", ip_address="192.168.1.91", name="Idle", auto_archive=False
        )
        await _start_with(lifecycle, busy, "cylinder_2_changes.3mf")

        await main.on_print_complete(busy.id, _done())
        await lifecycle.drain()

        assert await _counts(lifecycle, busy) == (3, 1)
        assert await _counts(lifecycle, idle) == (0, 0)


class TestStoppedRuns:
    @pytest.mark.parametrize("status", ["failed", "aborted", "cancelled"])
    async def test_a_stopped_run_counts_only_the_loads_it_reached(self, lifecycle, status):
        printer = await lifecycle.make_printer()
        await _start_with(lifecycle, printer, "cylinder_2_changes.3mf")

        # Layer 60 is past the first change (layer 57) and before the second (layer 96).
        await main.on_print_complete(printer.id, _done(status=status, last_layer_num=60))
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (2, 1)

    async def test_a_run_stopped_before_the_first_change_counts_the_initial_load(self, lifecycle):
        printer = await lifecycle.make_printer()
        await _start_with(lifecycle, printer, "cylinder_2_changes.3mf")

        await main.on_print_complete(printer.id, _done(status="failed", last_layer_num=10))
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (1, 1)

    async def test_a_stopped_run_with_no_known_layer_counts_what_is_certain(self, lifecycle):
        printer = await lifecycle.make_printer()
        await _start_with(lifecycle, printer, "cylinder_painted_74_changes.3mf")

        await main.on_print_complete(printer.id, _done(status="cancelled"))
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (1, 1)

    async def test_a_painted_run_stopped_part_way_counts_the_changes_reached(self, lifecycle):
        printer = await lifecycle.make_printer()
        await _start_with(lifecycle, printer, "cylinder_painted_74_changes.3mf")

        # Changes start at layer 24 and then happen on every layer: 1 load + 3 changes by layer 26.
        await main.on_print_complete(printer.id, _done(status="failed", last_layer_num=26))
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (4, 1)


class TestUncountableRuns:
    async def test_job_without_an_archive_adds_no_changes_but_still_counts_as_a_job(self, lifecycle):
        printer = await lifecycle.make_printer(auto_archive=False)

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (0, 1)

    async def test_missing_3mf_leaves_changes_unknown_without_losing_the_log(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start_with(lifecycle, printer, "cylinder_2_changes.3mf")
        (lifecycle.base_dir / archive.file_path).unlink()

        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        assert await _counts(lifecycle, printer) == (0, 1)
        assert len(await lifecycle.all(PrintLogEntry)) == 1

    async def test_a_counting_error_never_loses_the_print_log_entry(self, lifecycle):
        printer = await lifecycle.make_printer()
        archive = await _start_with(lifecycle, printer, "cylinder_2_changes.3mf")

        with patch(
            "backend.app.services.filament_changes.count_run_filament_changes",
            side_effect=RuntimeError("3mf exploded"),
        ):
            await main.on_print_complete(printer.id, _done())
            await lifecycle.drain()

        assert (await lifecycle.get(PrintArchive, archive.id)).status == "completed"
        assert len(await lifecycle.all(PrintLogEntry)) == 1
        assert await _counts(lifecycle, printer) == (0, 1)

    async def test_clearing_the_print_log_does_not_reset_the_count(self, lifecycle):
        from sqlalchemy import delete

        printer = await lifecycle.make_printer()
        await _start_with(lifecycle, printer, "cylinder_2_changes.3mf")
        await main.on_print_complete(printer.id, _done())
        await lifecycle.drain()

        async with lifecycle.session() as db:
            await db.execute(delete(PrintLogEntry))
            await db.commit()

        assert await _counts(lifecycle, printer) == (3, 1)
