"""Real-database regression coverage for queue heat-soak reservations and cleanup."""

import asyncio
import time
import zipfile
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from backend.app.core.config import settings
from backend.app.core.database import Base, _migrate_queue_lifecycle
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.schemas.print_queue import PrintQueueItemCreate, PrintQueueItemUpdate
from backend.app.services.bambu_mqtt import PrinterState
from backend.app.services.heat_soak_telemetry import record_heat_soak_reports
from backend.app.services.library_trash import release_queue_references
from backend.app.services.lifecycle import preheating as heat
from backend.app.services.print_scheduler import PrintScheduler, scheduler


@pytest.fixture
async def soak(tmp_path, monkeypatch):
    import backend.app.models  # noqa: F401
    from backend.app.core import tasks

    outcome_tasks = []
    spawn = tasks.spawn_background_task

    def track_outcomes(coroutine, *, name=None):
        task = spawn(coroutine, name=name)
        if name and name.startswith("queue-") and "-effects-" in name:
            outcome_tasks.append(task)
        return task

    async def wait_effects():
        await asyncio.gather(*outcome_tasks)
        outcome_tasks.clear()

    monkeypatch.setattr(tasks, "spawn_background_task", track_outcomes)

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    source_path = tmp_path / "soak.3mf"
    with zipfile.ZipFile(source_path, "w") as source_zip:
        source_zip.writestr("Metadata/plate_1.gcode", "G28\nM400\n")
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'soak.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate_queue_lifecycle(conn)
    # This connected client has already reported its idle job state.
    state = PrinterState(connected=True, state="IDLE", job_telemetry_ready=True)
    client = MagicMock()
    client.set_bed_temperature.return_value = True
    client.set_chamber_temperature.return_value = True
    client.set_airduct_mode.return_value = True
    manager = MagicMock()
    manager._broadcast_status_change = AsyncMock()
    manager.is_connected.return_value = True
    manager.is_awaiting_plate_clear.return_value = False
    manager.get_client.return_value = client
    manager.get_status.return_value = state
    monkeypatch.setattr(heat, "printer_manager", manager)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        printer = Printer(
            id=1, name="Test", serial_number="TEST", ip_address="127.0.0.1", access_code="12345678", model="H2D"
        )
        source = LibraryFile(
            filename="soak.3mf", file_path=str(source_path), file_type="3mf", file_size=source_path.stat().st_size
        )
        db.add_all([printer, source])
        await db.flush()
        item = PrintQueueItem(
            id=1,
            assigned_printer_id=1,
            library_file_id=source.id,
            chamber_heat_soak=True,
            heat_soak_minutes=1,
            status="queued",
        )
        db.add(item)
        await db.commit()
        yield SimpleNamespace(
            engine=engine,
            db=db,
            printer=printer,
            item=item,
            state=state,
            client=client,
            manager=manager,
            service=heat.ChamberHeatSoak(),
            wait_effects=wait_effects,
        )
        await wait_effects()
    await engine.dispose()


def confirm(soak, target=60):
    record_heat_soak_reports(
        soak.state,
        {
            "bed_target_temper": target,
            "device": {"ctc": {"info": {"target": target}}, "airduct": {"modeCur": int(target > 0)}},
        },
    )


@pytest.mark.parametrize(
    "model,chamber,airduct", [("H2D", True, True), ("X1C", False, False), ("P2S", False, True), ("A1", False, False)]
)
async def test_supported_controls_and_durable_reservation(soak, model, chamber, airduct):
    soak.printer.model = model
    await soak.db.commit()
    assert await soak.service.enter(soak.db, soak.item)
    await soak.db.refresh(soak.item)
    assert soak.item.status == "preheating"
    assert soak.item.preheat_started_at is not None
    soak.client.set_bed_temperature.assert_called_once_with(60)
    assert soak.client.set_chamber_temperature.called == chamber
    assert soak.client.set_airduct_mode.called == airduct
    soak.db.add(PrintQueueItem(printer_id=1, status="dispatching"))
    with pytest.raises(IntegrityError):
        await soak.db.commit()
    await soak.db.rollback()


async def test_bed_only_heating_starts_timer(soak):
    soak.printer.model = "P1S"
    await soak.db.commit()
    assert await soak.service.enter(soak.db, soak.item)
    await soak.db.refresh(soak.item)
    assert soak.item.preheat_started_at is not None


@pytest.mark.parametrize("stale_field", ["connected", "job_telemetry_ready"])
async def test_reconnect_during_staging_commit_cannot_send_heater_commands(soak, monkeypatch, stale_field):
    commit = soak.db.commit

    async def reconnect_after_hold():
        await commit()
        setattr(soak.state, stale_field, False)

    monkeypatch.setattr(soak.db, "commit", reconnect_after_hold)
    assert not await soak.service.enter(soak.db, soak.item)
    await soak.wait_effects()
    soak.client.set_bed_temperature.assert_not_called()
    soak.client.set_chamber_temperature.assert_not_called()
    soak.client.set_airduct_mode.assert_not_called()


async def test_failed_command_stops_every_supported_heater(soak):
    soak.client.set_chamber_temperature.return_value = False
    assert not await soak.service.enter(soak.db, soak.item)
    await soak.db.refresh(soak.item)
    assert soak.item.status == "failed"
    await soak.wait_effects()
    soak.client.set_bed_temperature.assert_called_with(0)
    soak.client.set_chamber_temperature.assert_called_with(0)
    soak.client.set_airduct_mode.assert_called_with("cooling")


async def test_abort_does_not_change_automatic_start_policy(soak):
    assert await soak.service.enter(soak.db, soak.item)
    await heat.abort_heat_soak(soak.db, soak.item, "Printer disconnected during soak")
    await soak.db.refresh(soak.item)
    assert soak.item.status == "failed"
    assert soak.item.manual_start is False


async def test_source_removal_preserves_queued_job_and_explains_missing_file(soak):
    source_id = soak.item.library_file_id
    assert await release_queue_references(soak.db, [source_id]) == 1
    await soak.db.commit()
    await soak.db.refresh(soak.item)
    assert soak.item.status == "queued"
    assert soak.item.library_file_id is None
    assert "was deleted from the library" in soak.item.error_message
    assert soak.item.completed_at is None


@pytest.mark.parametrize("schema", [PrintQueueItemCreate, PrintQueueItemUpdate])
@pytest.mark.parametrize(
    "field,value",
    [
        ("heat_soak_temperature", 29),
        ("heat_soak_temperature", 61),
        ("heat_soak_minutes", 0),
        ("heat_soak_minutes", 121),
        ("heat_soak_minutes", 1.5),
        ("heat_soak_temperature", None),
        ("chamber_heat_soak", None),
    ],
)
def test_schema_rejects_invalid_heat_soak_options(schema, field, value):
    with pytest.raises(ValidationError):
        schema(**{field: value})


def test_schema_defaults_are_off_and_patch_omission_preserves_existing_values():
    create = PrintQueueItemCreate()
    assert not create.chamber_heat_soak
    assert (create.heat_soak_temperature, create.heat_soak_minutes) == (60, 30)
    assert (create.bed_levelling, create.flow_cali, create.nozzle_offset_cali) == ("auto", "auto", "auto")
    assert PrintQueueItemUpdate().model_dump(exclude_unset=True) == {}


def test_telemetry_decodes_nested_firmware_targets_and_ignores_local_ui_values():
    state = PrinterState(temperatures={"chamber_target": 60})
    record_heat_soak_reports(
        state,
        {
            "device": {
                "bed": {"info": {"temp": 60 * 65536 + 35}},
                "ctc": {"info": {"temp": 50 * 65536 + 30, "target": 55}},
                "airduct": {"modeCur": 1},
            }
        },
    )
    assert state.heat_soak_reports["bed_target"][0] == 60
    assert state.heat_soak_reports["chamber_target"][0] == 55
    assert state.heat_soak_reports["airduct"][0] == 1


async def test_index_upgrade_includes_preheating_when_old_index_exists(soak):
    async with soak.engine.begin() as conn:
        await conn.execute(text("DROP INDEX uq_print_queue_holding_printer"))
        await conn.execute(
            text(
                "CREATE UNIQUE INDEX uq_print_queue_active_printer ON print_queue(printer_id) "
                "WHERE status IN ('dispatching', 'printing')"
            )
        )
        await _migrate_queue_lifecycle(conn)
        await _migrate_queue_lifecycle(conn)
    await soak.service.enter(soak.db, soak.item)
    soak.db.add(PrintQueueItem(printer_id=1, status="preheating"))
    with pytest.raises(IntegrityError):
        await soak.db.commit()
    await soak.db.rollback()


async def test_upgrade_defaults_existing_rows_to_off(tmp_path):
    from backend.app.core.database import ensure_queue_insert_schema

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy-soak.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
            )
            await conn.execute(text("INSERT INTO print_queue (id) VALUES (1)"))
            await ensure_queue_insert_schema(conn)
            await ensure_queue_insert_schema(conn)
            row = (
                await conn.execute(
                    text(
                        "SELECT chamber_heat_soak, heat_soak_temperature, heat_soak_minutes, "
                        "preheat_started_at FROM print_queue"
                    )
                )
            ).one()
            assert tuple(row) == (0, 60, 30, None)
    finally:
        await engine.dispose()
