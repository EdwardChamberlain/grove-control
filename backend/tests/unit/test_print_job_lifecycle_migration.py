"""Migration safety checks for adoption of legacy print_queue rows."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from backend.app.core.database import _migrate_print_job_lifecycle


async def _replace_queue_with_legacy_shape(conn) -> None:
    """Make a pre-PrintJob queue table while retaining the new side tables."""
    await conn.execute(text("DROP TABLE print_queue"))
    await conn.execute(
        text(
            "CREATE TABLE print_queue ("
            "id INTEGER PRIMARY KEY, printer_id INTEGER, status VARCHAR(20), "
            "dispatched_at DATETIME, preheat_owner VARCHAR(36)"
            ")"
        )
    )


@pytest.mark.asyncio
async def test_legacy_active_conflict_is_quarantined_without_a_recency_election(test_engine):
    async with test_engine.begin() as conn:
        await _replace_queue_with_legacy_shape(conn)
        await conn.execute(
            text(
                "INSERT INTO printers (id, name, serial_number, ip_address, access_code, model, nozzle_count, "
                "is_active, auto_archive, print_hours_offset, runtime_seconds, external_camera_enabled, "
                "camera_rotation, plate_detection_enabled, awaiting_plate_clear) "
                "VALUES (1, 'P1', 'MIGRATION-1', '127.0.0.1', '12345678', 'H2D', 1, 1, 1, 0, 0, 0, 0, 0, 0)"
            )
        )
        await conn.execute(
            text("INSERT INTO print_queue (id, printer_id, status) VALUES (1, 1, 'printing'), (2, 1, 'dispatching')")
        )

        await _migrate_print_job_lifecycle(conn)

        rows = (
            (
                await conn.execute(
                    text(
                        "SELECT id, lifecycle_state, uncertainty_status, job_id FROM print_queue "
                        "WHERE printer_id = 1 ORDER BY id"
                    )
                )
            )
            .mappings()
            .all()
        )
        hold = (
            await conn.execute(
                text("SELECT hold_type FROM printer_safety_holds WHERE printer_id = 1 AND state = 'active'")
            )
        ).scalar_one()
        reservations = (
            await conn.execute(text("SELECT COUNT(*) FROM print_job_reservations WHERE printer_id = 1"))
        ).scalar_one()

    assert [row["lifecycle_state"] for row in rows] == ["printing", "dispatching"]
    assert all(row["job_id"] and row["uncertainty_status"] == "legacy_active_identity_conflict" for row in rows)
    assert hold == "legacy_active_identity_conflict"
    assert reservations == 0


@pytest.mark.asyncio
async def test_legacy_heat_soak_is_not_migrated_as_a_live_worker_lease(test_engine):
    async with test_engine.begin() as conn:
        await _replace_queue_with_legacy_shape(conn)
        await conn.execute(
            text(
                "INSERT INTO printers (id, name, serial_number, ip_address, access_code, model, nozzle_count, "
                "is_active, auto_archive, print_hours_offset, runtime_seconds, external_camera_enabled, "
                "camera_rotation, plate_detection_enabled, awaiting_plate_clear) "
                "VALUES (1, 'P1', 'MIGRATION-HEAT', '127.0.0.1', '12345678', 'H2D', 1, 1, 1, 0, 0, 0, 0, 0, 0)"
            )
        )
        await conn.execute(
            text(
                "INSERT INTO print_queue (id, printer_id, status, preheat_owner) "
                "VALUES (1, 1, 'preheating', 'old-worker')"
            )
        )

        await _migrate_print_job_lifecycle(conn)
        row = (
            (
                await conn.execute(
                    text("SELECT lifecycle_state, uncertainty_status, preheat_owner FROM print_queue WHERE id = 1")
                )
            )
            .mappings()
            .one()
        )

    assert row["lifecycle_state"] == "heat_soaking"
    assert row["uncertainty_status"] == "legacy_heat_soak_identity_unverified"
    assert row["preheat_owner"] is None


@pytest.mark.asyncio
async def test_legacy_rows_gain_events_and_only_exact_log_identity_is_backfilled(test_engine):
    async with test_engine.begin() as conn:
        await _replace_queue_with_legacy_shape(conn)
        await conn.execute(
            text(
                "INSERT INTO printers (id, name, serial_number, ip_address, access_code, model, nozzle_count, "
                "is_active, auto_archive, print_hours_offset, runtime_seconds, external_camera_enabled, "
                "camera_rotation, plate_detection_enabled, awaiting_plate_clear) "
                "VALUES (1, 'P1', 'MIGRATION-2', '127.0.0.1', '12345678', 'H2D', 1, 1, 1, 0, 0, 0, 0, 0, 0)"
            )
        )
        await conn.execute(
            text("INSERT INTO print_queue (id, printer_id, status) VALUES (1, 1, 'completed'), (2, 1, 'completed')")
        )
        await conn.execute(
            text(
                "INSERT INTO print_log_entries (id, queue_item_id, status) "
                "VALUES (1, 1, 'completed'), (2, 2, 'completed'), (3, 2, 'completed')"
            )
        )

        await _migrate_print_job_lifecycle(conn)
        events = (
            await conn.execute(text("SELECT COUNT(*) FROM print_job_events WHERE event_type = 'job_admitted'"))
        ).scalar_one()
        jobs = (
            (await conn.execute(text("SELECT id, job_id, queue_visible FROM print_queue ORDER BY id"))).mappings().all()
        )
        logs = (await conn.execute(text("SELECT id, job_id FROM print_log_entries ORDER BY id"))).mappings().all()

    assert events == 2
    assert all(row["job_id"] and not row["queue_visible"] for row in jobs)
    assert logs[0]["job_id"] == jobs[0]["job_id"]
    assert logs[1]["job_id"] is None
    assert logs[2]["job_id"] is None


@pytest.mark.asyncio
async def test_lifecycle_evidence_is_database_append_only_after_migration(test_engine):
    async with test_engine.begin() as conn:
        await _migrate_print_job_lifecycle(conn)
        await conn.execute(
            text(
                "INSERT INTO print_job_events "
                "(id, job_id, lifecycle_version, event_type, source) "
                "VALUES ('event-1', 'job-1', 0, 'job_admitted', 'test')"
            )
        )
        with pytest.raises(IntegrityError, match="append-only"):
            await conn.execute(text("UPDATE print_job_events SET source = 'rewritten' WHERE id = 'event-1'"))
