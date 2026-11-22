"""Stats must describe the dispatched run's actual filament (#340)."""

import io
import json
import zipfile
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.filament_override_stats import resolve_run_filament_metadata

pytestmark = pytest.mark.integration


def _two_plate_source():
    xml = (
        '<config><plate><metadata key="index" value="1"/>'
        '<filament id="1" type="PLA" color="#000000" used_g="10"/></plate>'
        '<plate><metadata key="index" value="2"/>'
        '<filament id="2" type="PETG" color="#FFFFFF" used_g="20"/></plate></config>'
    )
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("Metadata/slice_info.config", xml)
    return data.getvalue()


async def _queued_run(lifecycle, *, plate_id=1, color="#0000FF", status="printing"):
    printer = await lifecycle.make_printer()
    path = lifecycle.base_dir / "archive" / "Overridden.gcode.3mf"
    path.write_bytes(_two_plate_source())
    archive = await lifecycle.make_archive(
        printer.id,
        filename=path.name,
        print_name="Overridden",
        file_path=str(path.relative_to(lifecycle.base_dir)),
        filament_type="PLA, PETG",
        filament_color="#000000,#FFFFFF",
        filament_used_grams=30,
        started_at=datetime.now(timezone.utc),
    )
    item = await lifecycle.add(
        PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status=status,
            plate_id=plate_id,
            ams_mapping="[0]" if plate_id != 2 else "[-1,0]",
            dispatch_subtask_id="this-run",
            filament_overrides=json.dumps(
                [{"slot_id": 2 if plate_id == 2 else 1, "type": "PETG" if plate_id == 2 else "PLA", "color": color}]
            ),
        )
    )
    main._active_prints[(printer.id, archive.filename)] = archive.id
    return printer, archive, item


@pytest.mark.parametrize("plate_id, material", [(None, "PLA"), (1, "PLA"), (2, "PETG")])
@pytest.mark.parametrize("status", ["completed", "failed"])
async def test_stats_uses_only_the_dispatched_plate(lifecycle, async_client, plate_id, material, status):
    printer, archive, item = await _queued_run(lifecycle, plate_id=plate_id)
    await main.on_print_complete(printer.id, {"status": status, "filename": archive.filename, "progress": 50})
    await lifecycle.drain()

    [run] = await lifecycle.all(PrintLogEntry)
    assert (run.filament_type, run.filament_color) == (material, "#0000FF")
    # Each run owns its attribution; shared source metadata is left intact.
    source = await lifecycle.get(PrintArchive, archive.id)
    assert source.filament_color == "#000000,#FFFFFF"
    response = await async_client.get("/api/v1/archives/slim")
    assert response.status_code == 200
    assert response.json()[0]["filament_color"] == "#0000FF"
    stats = await async_client.get("/api/v1/archives/stats")
    assert stats.status_code == 200
    assert stats.json()["prints_by_filament_type"] == {material: 1}


async def test_tracked_filament_overrules_requested_color(lifecycle, async_client):
    printer, archive, _item = await _queued_run(lifecycle)
    usage = [{"slot_id": 1, "material": "PLA", "color": "#FF0000", "weight_used": 10}]
    with patch("backend.app.services.usage_tracker.on_print_complete", AsyncMock(return_value=usage)):
        await main.on_print_complete(printer.id, {"status": "completed", "filename": archive.filename})
    await lifecycle.drain()

    [run] = await lifecycle.all(PrintLogEntry)
    assert run.filament_color == "#FF0000"
    response = await async_client.get("/api/v1/archives/slim")
    assert response.status_code == 200
    assert response.json()[0]["filament_color"] == "#FF0000"


@pytest.mark.parametrize("restart", [False, True])
async def test_queue_stop_keeps_override_without_inventory(lifecycle, async_client, restart):
    printer, archive, item = await _queued_run(lifecycle)
    with (
        patch("backend.app.api.routes.print_queue.ws_manager", lifecycle.ws),
        patch("backend.app.services.printer_manager.printer_manager.stop_print", return_value=True),
    ):
        response = await async_client.post(f"/api/v1/queue/{item.id}/stop")
    assert response.status_code == 200, response.text
    assert (await lifecycle.get(PrintQueueItem, item.id)).status == "cancelled"
    data = {"status": "aborted", "filename": archive.filename, "last_progress": 50}
    if restart:
        main._user_stopped_printers.clear()
        main._user_stopped_queue_item_ids.clear()
        data["subtask_id"] = "this-run"
    await main.on_print_complete(printer.id, data)
    await lifecycle.drain()

    [run] = await lifecycle.all(PrintLogEntry)
    assert (run.filament_type, run.filament_color) == ("PLA", "#0000FF")


async def test_reprints_keep_independent_color_history(lifecycle):
    printer, archive, first = await _queued_run(lifecycle)
    await main.on_print_complete(printer.id, {"status": "completed", "filename": archive.filename})
    await lifecycle.drain()
    await lifecycle.add(
        PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status="printing",
            plate_id=1,
            filament_overrides='[{"slot_id":1,"type":"PLA","color":"#00FF00"}]',
        )
    )
    main._active_prints[(printer.id, archive.filename)] = archive.id
    await main.on_print_complete(printer.id, {"status": "completed", "filename": archive.filename})
    await lifecycle.drain()

    runs = await lifecycle.all(PrintLogEntry)
    assert {run.filament_color for run in runs} == {"#0000FF", "#00FF00"}
    assert (await lifecycle.get(PrintQueueItem, first.id)).status == "completed"
    assert (await lifecycle.get(PrintArchive, archive.id)).filament_color == "#000000,#FFFFFF"


@pytest.mark.parametrize(
    "fallback_case", ["no-identity", "wrong-run", "missing-source", "wrong-plate", "unsafe-path", "no-overrides"]
)
async def test_unresolved_queue_run_keeps_existing_metadata(lifecycle, fallback_case):
    printer, archive, item = await _queued_run(lifecycle)
    async with lifecycle.session() as db:
        source = await db.get(PrintArchive, archive.id)
        row = await db.get(PrintQueueItem, item.id)
        if fallback_case == "missing-source":
            source.file_path = "archive/missing.3mf"
        elif fallback_case == "unsafe-path":
            source.file_path = "../../outside.3mf"
        elif fallback_case == "wrong-plate":
            row.plate_id = 3
        elif fallback_case == "no-overrides":
            row.filament_overrides = None
        result = await resolve_run_filament_metadata(
            db,
            source,
            printer.id,
            [],
            queue_item_id=None if fallback_case == "no-identity" else item.id + (fallback_case == "wrong-run"),
        )
    assert result == ("PLA, PETG", "#000000,#FFFFFF")


async def test_tracked_filament_applies_without_overrides(lifecycle):
    printer, archive, item = await _queued_run(lifecycle)
    async with lifecycle.session() as db:
        (await db.get(PrintQueueItem, item.id)).filament_overrides = None
    usage = [{"slot_id": 1, "material": "PLA", "color": "#FF0000", "weight_used": 10}]
    with patch("backend.app.services.usage_tracker.on_print_complete", AsyncMock(return_value=usage)):
        await main.on_print_complete(printer.id, {"status": "completed", "filename": archive.filename})
    await lifecycle.drain()

    [run] = await lifecycle.all(PrintLogEntry)
    assert (run.filament_type, run.filament_color) == ("PLA", "#FF0000")


async def test_duplicate_dispatch_id_does_not_break_resolution(lifecycle):
    printer, archive, item = await _queued_run(lifecycle)
    await lifecycle.add(
        PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status="completed",
            plate_id=1,
            dispatch_subtask_id="this-run",
            filament_overrides='[{"slot_id":1,"type":"PLA","color":"#00FF00"}]',
        )
    )
    async with lifecycle.session() as db:
        source = await db.get(PrintArchive, archive.id)
        result = await resolve_run_filament_metadata(db, source, printer.id, [], dispatch_subtask_id="this-run")
    assert result[0] == "PLA"


async def test_resolver_failure_still_writes_log_entry(lifecycle):
    printer, archive, _item = await _queued_run(lifecycle)
    with patch(
        "backend.app.services.filament_override_stats.resolve_run_filament_metadata",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        await main.on_print_complete(printer.id, {"status": "completed", "filename": archive.filename})
    await lifecycle.drain()

    [run] = await lifecycle.all(PrintLogEntry)
    assert (run.filament_type, run.filament_color) == ("PLA, PETG", "#000000,#FFFFFF")
