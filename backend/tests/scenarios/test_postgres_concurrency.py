"""Database-boundary lifecycle races that require PostgreSQL row locks."""

import asyncio
import os

import pytest
from sqlalchemy import select, text, update

from backend.app.models.print_queue import PrintQueueItem
from backend.tests.scenarios.test_print import printing_job

pytestmark = pytest.mark.skipif(
    not os.environ.get("LIFECYCLE_POSTGRES_TEST_URL"),
    reason="PostgreSQL-only lifecycle regressions run in the dedicated CI service job",
)


async def _wait_for_queue_lock_wait(app) -> list[str]:
    """Return queries currently blocked on a queue row, using PostgreSQL's lock table."""
    for _ in range(500):
        async with app.session() as db:
            queries = list(
                await db.scalars(
                    text(
                        "SELECT query FROM pg_stat_activity "
                        "WHERE datname = current_database() "
                        "AND wait_event_type = 'Lock' AND query ILIKE '%print_queue%'"
                    )
                )
            )
        if queries:
            return queries
        await asyncio.sleep(0.01)
    raise AssertionError("no transaction reached a PostgreSQL queue-row lock wait")


async def _stop_intake_race(app, monkeypatch, printer, job_id, blocker):
    from backend.app.api.routes import printers as printer_routes
    from backend.app.services.lifecycle import intake

    job = await app.job(job_id)
    printer.client.on_state_change = None
    printer.push(gcode_state="PAUSE")
    printer.client.on_state_change = None

    intake_entered = asyncio.Event()
    finish_intake = asyncio.Event()
    original_intake_hold = intake.hold_printer
    intake_task = None

    async def gated_intake_hold(db, printer_id):
        await original_intake_hold(db, printer_id)
        if asyncio.current_task() is intake_task:
            intake_entered.set()
            await finish_intake.wait()

    monkeypatch.setattr(intake, "hold_printer", gated_intake_hold)
    intake_task = app.spawn(
        intake.print_state_changed(printer.printer_id, {"submission_id": job.dispatch_subtask_id, "state": "PAUSE"})
    )
    stop_lock_attempted = asyncio.Event()
    stop_task = None
    original_route_hold = printer_routes.hold_printer

    async def observe_stop_lock(db, printer_id):
        if asyncio.current_task() is stop_task:
            stop_lock_attempted.set()
        await original_route_hold(db, printer_id)

    monkeypatch.setattr(printer_routes, "hold_printer", observe_stop_lock)
    await asyncio.wait_for(intake_entered.wait(), timeout=5)
    stop_task = app.spawn(app.http.post(f"/printers/{printer.printer_id}/print/stop"))
    try:
        await asyncio.wait_for(stop_lock_attempted.wait(), timeout=5)
        finish_intake.set()
        waiting = await _wait_for_queue_lock_wait(app)
        assert any("update print_queue" in query.lower() for query in waiting), waiting
        assert not any("for update" in query.lower() for query in waiting), waiting
        await blocker.commit()
        response, _ = await asyncio.wait_for(asyncio.gather(stop_task, intake_task), timeout=8)
        assert response.status_code == 200, response.text
        await app.settle()
        assert (await app.job(job_id)).status == "cancelled"
        assert len(printer.sent("stop")) == 1
    finally:
        finish_intake.set()
        if blocker.in_transaction():
            await blocker.rollback()
        for task in (stop_task, intake_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in (stop_task, intake_task) if task is not None), return_exceptions=True)


async def test_stop_waits_for_intake_before_taking_the_job_row_lock(postgres_app, monkeypatch):
    printer, job_id = await printing_job(postgres_app)
    blocker = postgres_app.session()
    await blocker.execute(select(PrintQueueItem.id).where(PrintQueueItem.id == job_id).with_for_update())
    await _stop_intake_race(postgres_app, monkeypatch, printer, job_id, blocker)


async def test_printer_deletion_waits_for_intake_before_taking_held_job_rows(postgres_app, monkeypatch):
    from backend.app.services.lifecycle import engine as lifecycle_engine, intake

    printer, job_id = await printing_job(postgres_app)
    printer.finish()
    await postgres_app.run()
    assert (await postgres_app.job(job_id)).status == "finished"

    original_start = printer.client.on_print_start
    original_state = printer.client.on_state_change
    printer.client.on_print_start = None
    printer.client.on_state_change = None
    printer.start_local("external.3mf", subtask_id="778")
    printer.client.on_print_start = original_start
    printer.client.on_state_change = original_state

    blocker = postgres_app.session()
    await blocker.execute(select(PrintQueueItem.id).where(PrintQueueItem.id == job_id).with_for_update())

    intake_entered = asyncio.Event()
    finish_intake = asyncio.Event()
    original_intake_hold = intake.hold_printer
    intake_task = None

    async def gated_intake_hold(db, printer_id):
        await original_intake_hold(db, printer_id)
        if asyncio.current_task() is intake_task:
            intake_entered.set()
            await finish_intake.wait()

    monkeypatch.setattr(intake, "hold_printer", gated_intake_hold)
    intake_task = postgres_app.spawn(intake.print_started(printer.printer_id, {"submission_id": "778"}))

    deletion_lock_attempted = asyncio.Event()
    delete_task = None
    original_engine_hold = lifecycle_engine.hold_printer

    async def observe_delete_lock(db, printer_id):
        if asyncio.current_task() is delete_task:
            deletion_lock_attempted.set()
        await original_engine_hold(db, printer_id)

    monkeypatch.setattr(lifecycle_engine, "hold_printer", observe_delete_lock)
    await asyncio.wait_for(intake_entered.wait(), timeout=5)
    delete_task = postgres_app.spawn(postgres_app.http.delete(f"/printers/{printer.printer_id}"))
    try:
        await asyncio.wait_for(deletion_lock_attempted.wait(), timeout=5)
        finish_intake.set()
        waiting = await _wait_for_queue_lock_wait(postgres_app)
        assert any("update print_queue" in query.lower() for query in waiting), waiting
        assert not any("for update" in query.lower() for query in waiting), waiting
        await blocker.commit()
        response, _ = await asyncio.wait_for(asyncio.gather(delete_task, intake_task), timeout=8)
        assert response.status_code == 200, response.text
        await postgres_app.settle()
        assert (await postgres_app.job(job_id)).status == "successful"
        external = next(job for job in await postgres_app.jobs() if job.dispatch_subtask_id == "778")
        assert external.status == "unsuccessful"
        assert printer.sent("stop") == []
    finally:
        finish_intake.set()
        if blocker.in_transaction():
            await blocker.rollback()
        for task in (delete_task, intake_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in (delete_task, intake_task) if task is not None), return_exceptions=True)


async def test_bulk_updates_lock_multiple_printers_in_one_order(postgres_app):
    first_printer = await postgres_app.add_printer("first")
    second_printer = await postgres_app.add_printer("second")
    file_id = await postgres_app.add_file()
    first = await postgres_app.queue(first_printer, file_id)
    second = await postgres_app.queue(second_printer, file_id)

    first_response, second_response = await asyncio.wait_for(
        asyncio.gather(
            postgres_app.http.patch("/queue/bulk", json={"item_ids": [first, second], "manual_start": True}),
            postgres_app.http.patch("/queue/bulk", json={"item_ids": [second, first], "flow_cali": "on"}),
        ),
        timeout=8,
    )
    assert first_response.status_code == second_response.status_code == 200
    assert first_response.json()["updated_count"] == second_response.json()["updated_count"] == 2
    for job_id in (first, second):
        item = await postgres_app.job(job_id)
        assert item.manual_start is True
        assert item.flow_cali == "on"


async def test_bulk_retarget_conflict_rolls_back_the_whole_request(postgres_app, monkeypatch):
    from backend.app.api.routes import print_queue as queue_routes

    source = await postgres_app.add_printer("source")
    destination = await postgres_app.add_printer("destination")
    concurrent_target = await postgres_app.add_printer("concurrent-target")
    file_id = await postgres_app.add_file()
    first = await postgres_app.queue(source, file_id, bed_levelling="on")
    moved = await postgres_app.queue(source, file_id, bed_levelling="on")
    original_hold = queue_routes.hold_printers
    changed = False

    async def reassign_after_discovery(db, printer_ids):
        nonlocal changed
        if not changed:
            changed = True
            async with postgres_app.session() as concurrent:
                await concurrent.execute(
                    update(PrintQueueItem)
                    .where(PrintQueueItem.id == moved)
                    .values(printer_id=concurrent_target.printer_id)
                )
                await concurrent.commit()
        await original_hold(db, printer_ids)

    monkeypatch.setattr(queue_routes, "hold_printers", reassign_after_discovery)
    response = await postgres_app.http.patch(
        "/queue/bulk",
        json={"item_ids": [first, moved], "printer_id": destination.printer_id, "bed_levelling": "off"},
    )
    assert response.status_code == 409, response.text
    assert (await postgres_app.job(first)).bed_levelling == "on"
    moved_item = await postgres_app.job(moved)
    assert moved_item.printer_id == concurrent_target.printer_id
    assert moved_item.bed_levelling == "on"


async def test_dispatch_can_race_a_bulk_edit_without_database_lock_errors(postgres_app):
    printer = await postgres_app.add_printer()
    file_id = await postgres_app.add_file()
    first = await postgres_app.queue(printer, file_id)
    second = await postgres_app.queue(printer, file_id)

    response, _ = await asyncio.wait_for(
        asyncio.gather(
            postgres_app.http.patch("/queue/bulk", json={"item_ids": [first, second], "manual_start": True}),
            postgres_app.run(rounds=1),
        ),
        timeout=8,
    )
    assert response.status_code == 200, response.text
    assert (await postgres_app.job(first)).status in ("queued", "printing")
    assert (await postgres_app.job(second)).status in ("queued", "printing")
