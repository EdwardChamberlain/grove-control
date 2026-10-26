"""Stopped queue prints must keep their own plate and spool mapping."""

import io
import zipfile
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from backend.app import main
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.models.spool_usage_history import SpoolUsageHistory

pytestmark = pytest.mark.integration


def _two_plate_3mf():
    xml = (
        '<config><plate><metadata key="index" value="1"/>'
        '<filament id="1" type="PLA" color="#FF0000" used_g="20"/></plate>'
        '<plate><metadata key="index" value="2"/>'
        '<filament id="1" type="PLA" color="#FF0000" used_g="80"/></plate></config>'
    )
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("Metadata/slice_info.config", xml)
    return data.getvalue()


@pytest.mark.parametrize("restart_before_completion", [False, True])
async def test_stop_uses_printed_run_instead_of_newer_cancelled_row(lifecycle, async_client, restart_before_completion):
    printer = await lifecycle.make_printer()
    path = lifecycle.base_dir / "archive" / "Reused.gcode.3mf"
    path.write_bytes(_two_plate_3mf())
    archive = await lifecycle.make_archive(
        printer.id,
        filename="Reused.gcode.3mf",
        print_name="Reused",
        file_path=str(path.relative_to(lifecycle.base_dir)),
    )
    current = await lifecycle.add(
        PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status="printing",
            plate_id=1,
            ams_mapping="[0]",
            dispatch_subtask_id="printed-run",
            started_at=datetime.now(timezone.utc),
        )
    )
    later = await lifecycle.add(
        PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status="pending",
            plate_id=2,
            ams_mapping="[1]",
        )
    )
    printed_spool, other_spool = await lifecycle.add(
        Spool(material="PLA", label_weight=1000, weight_used=0),
        Spool(material="PLA", label_weight=1000, weight_used=0),
    )
    await lifecycle.add(
        SpoolAssignment(printer_id=printer.id, ams_id=0, tray_id=0, spool_id=printed_spool.id),
        SpoolAssignment(printer_id=printer.id, ams_id=0, tray_id=1, spool_id=other_spool.id),
    )
    lifecycle.printer_manager.get_status.return_value = SimpleNamespace(
        raw_data={},
        state="IDLE",
        progress=50,
        layer_num=0,
        total_layers=0,
        tray_now=255,
        last_loaded_tray=-1,
        tray_change_log=[],
    )
    main._active_prints[(printer.id, archive.filename)] = archive.id

    with (
        patch("backend.app.api.routes.print_queue.ws_manager", lifecycle.ws),
        patch("backend.app.services.printer_manager.printer_manager.stop_print", return_value=True),
    ):
        cancelled = await async_client.post(f"/api/v1/queue/{later.id}/cancel")
        stopped = await async_client.post(f"/api/v1/queue/{current.id}/stop")
    assert cancelled.status_code == 200, cancelled.text
    assert stopped.status_code == 200, stopped.text
    assert (await lifecycle.get(PrintQueueItem, current.id)).status == "cancelled"
    assert (await lifecycle.get(PrintQueueItem, later.id)).status == "cancelled"

    data = {"status": "aborted", "filename": archive.filename, "subtask_name": "Reused", "last_progress": 50}
    if restart_before_completion:
        # The durable dispatch ID must work when Stop's process-local marker
        # has gone. The other case deliberately has no MQTT subtask ID.
        main._user_stopped_printers.clear()
        main._user_stopped_queue_item_ids.clear()
        data["subtask_id"] = "printed-run"

    await main.on_print_complete(printer.id, data)
    await lifecycle.drain()

    assert (await lifecycle.get(Spool, printed_spool.id)).weight_used == 10
    assert (await lifecycle.get(Spool, other_spool.id)).weight_used == 0
    history = await lifecycle.all(SpoolUsageHistory)
    assert [(row.spool_id, row.weight_used) for row in history] == [(printed_spool.id, 10)]
    assert printer.id not in main._user_stopped_queue_item_ids
