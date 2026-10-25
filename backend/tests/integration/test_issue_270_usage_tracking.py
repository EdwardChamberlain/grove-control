"""Regression coverage for archived usage tracking without an in-memory plate."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from backend.app.core.config import settings
from backend.app.models.spool import Spool
from backend.app.models.spool_usage_history import SpoolUsageHistory
from backend.app.services import usage_tracker

pytestmark = pytest.mark.integration


async def test_archived_print_without_session_plate_records_3mf_usage(
    db_session, printer_factory, archive_factory, monkeypatch, tmp_path
):
    printer = await printer_factory()
    relative_path = "archives/test/plate_1.gcode.3mf"
    archive = await archive_factory(printer.id, file_path=relative_path, print_name="Gear box")
    source_path = tmp_path / relative_path
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(b"3mf fixture")
    monkeypatch.setattr(settings, "base_dir", tmp_path)

    spool = Spool(material="PLA", label_weight=1000, weight_used=0)
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)

    usage_tracker._active_sessions[printer.id] = usage_tracker.PrintSession(
        printer_id=printer.id,
        print_name="Gear box",
        started_at=datetime.now(timezone.utc),
        ams_mapping=[0],
        spool_assignments={(0, 0): spool.id},
        plate_id=None,
    )
    printer_manager = MagicMock()
    printer_manager.get_status.return_value = SimpleNamespace(
        raw_data={}, progress=100, layer_num=50, tray_now=0, last_loaded_tray=0, tray_change_log=[]
    )
    filament_usage = [{"slot_id": 1, "used_g": 12.5, "type": "PLA", "color": ""}]

    with patch(
        "backend.app.utils.threemf_tools.extract_filament_usage_from_3mf", return_value=filament_usage
    ) as extract_usage:
        results = await usage_tracker.on_print_complete(
            printer_id=printer.id,
            data={"status": "completed"},
            printer_manager=printer_manager,
            db=db_session,
            archive_id=archive.id,
            ams_mapping=[0],
        )

    await db_session.refresh(spool)
    history_result = await db_session.execute(
        select(SpoolUsageHistory).where(
            SpoolUsageHistory.archive_id == archive.id,
            SpoolUsageHistory.spool_id == spool.id,
        )
    )
    history = history_result.scalar_one()

    extract_usage.assert_called_once_with(source_path, None)
    assert len(results) == 1
    assert results[0]["weight_used"] == 12.5
    assert spool.weight_used == 12.5
    assert history.weight_used == 12.5
    assert history.status == "completed"
