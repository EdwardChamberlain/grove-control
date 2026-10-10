"""Chamber heat soak before a print, on a printer with a chamber heater."""

import asyncio

from sqlalchemy import update

from backend.app.models.print_queue import PrintQueueItem
from backend.tests.scenarios.fake_printer import sliced_3mf

SOAK = {"chamber_heat_soak": True, "heat_soak_temperature": 45, "heat_soak_minutes": 10}


def gcode(printer) -> list[str]:
    return [body.get("param", "") for body in printer.sent("gcode_line")]


async def soaking_job(app):
    printer = await app.add_printer(model="H2D")
    job_id = await app.queue(printer, await app.add_file(), **SOAK)
    await app.run()
    assert (await app.job(job_id)).status == "preheating"
    assert "M140 S45" in gcode(printer)
    assert "M141 S45" in gcode(printer)
    return printer, job_id


async def test_soak_heats_waits_then_prints(app):
    printer, job_id = await soaking_job(app)

    await app.advance(5 * 60)
    assert (await app.job(job_id)).status == "preheating"
    assert printer.sent("project_file") == []

    await app.advance(6 * 60)
    assert (await app.job(job_id)).status == "printing"
    assert len(printer.sent("project_file")) == 1


async def test_skip_soak_prints_at_once(app):
    printer, job_id = await soaking_job(app)

    response = await app.action(job_id, "skip-heat-soak")
    assert response.status_code == 200, response.text
    await app.run()

    assert (await app.job(job_id)).status == "printing"


async def test_stop_during_soak_turns_the_heaters_off(app):
    printer, job_id = await soaking_job(app)

    await app.action(job_id, "stop")
    await app.run()

    assert (await app.job(job_id)).status == "unsuccessful"
    assert "M140 S0" in gcode(printer)
    assert "M141 S0" in gcode(printer)
    assert printer.sent("project_file") == []
    assert printer.sent("stop") == []  # A soak has no print to stop.


async def test_soak_interrupted_by_restart_turns_heaters_off_and_keeps_the_hold(app):
    printer, job_id = await soaking_job(app)

    await app.restart()
    await app.advance(5 * 60)

    job = await app.job(job_id)
    assert job.status == "preheating"
    assert job.error_message
    assert "M140 S0" in gcode(printer)
    assert printer.sent("project_file") == []

    await app.action(job_id, "stop")
    await app.run()
    assert (await app.job(job_id)).status == "unsuccessful"


async def _persist_unstarted_soak(app):
    printer = await app.add_printer(model="H2D")
    job_id = await app.queue(printer, await app.add_file(), **SOAK)
    async with app.session() as db:
        await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == job_id)
            .values(
                status="preheating",
                printer_id=printer.printer_id,
                assigned_printer_id=None,
                preheat_requested_at=app.clock.now(),
            )
        )
        await db.commit()
    return printer, job_id


async def test_restart_after_the_preheating_hold_but_before_heating_keeps_the_job_parked(app):
    printer, job_id = await _persist_unstarted_soak(app)

    await app.restart(abrupt=True)
    await app.run()

    job = await app.job(job_id)
    assert job.status == "preheating"
    assert job.deadline_at is None
    assert job.error_message
    assert "M140 S0" in gcode(printer)
    assert printer.sent("project_file") == []


async def test_restart_after_heater_commands_before_deadline_commit_requests_shutdown(app, monkeypatch):
    printer, job_id = await _persist_unstarted_soak(app)

    from backend.app.services.lifecycle import preheating

    original_transition = preheating.transition_queue_item

    class PowerLoss(BaseException):
        pass

    async def lose_power_after_transition(*args, **kwargs):
        await original_transition(*args, **kwargs)
        raise PowerLoss

    with monkeypatch.context() as crash:
        crash.setattr(preheating, "transition_queue_item", lose_power_after_transition)
        try:
            async with app.session() as db:
                await preheating.start_heating(db, job_id)
        except PowerLoss:
            pass
        else:
            raise AssertionError("the simulated power loss did not interrupt the heater transaction")

    interrupted = await app.job(job_id)
    assert interrupted.status == "preheating"
    assert interrupted.deadline_at is None
    assert "M140 S45" in gcode(printer)

    await app.restart(abrupt=True)
    await app.run()
    await app.restart(abrupt=True)
    await app.run()

    job = await app.job(job_id)
    assert job.status == "preheating"
    assert job.deadline_at is None
    assert job.error_message
    assert "M140 S0" in gcode(printer)
    assert printer.sent("project_file") == []


async def test_printer_lost_during_soak_ends_the_soak(app):
    printer, job_id = await soaking_job(app)

    printer.disconnect()
    await app.advance(60)

    assert (await app.job(job_id)).status == "failed"
    assert printer.sent("project_file") == []


async def test_stop_as_the_soak_hands_off_sends_nothing_and_turns_heaters_off(app):
    printer, job_id = await soaking_job(app)
    printer.upload_gate = asyncio.Event()
    await app.advance(9 * 60)
    running = app.spawn(app.advance(2 * 60))
    await app.until(lambda: printer.uploading, attempts=1000)

    await app.action(job_id, "stop")
    printer.upload_gate.set()
    await running
    await app.run()

    assert (await app.job(job_id)).status == "unsuccessful"
    assert printer.sent("project_file") == []
    assert "M140 S0" in gcode(printer)


async def test_a_touchscreen_print_during_the_soak_ends_it(app):
    printer, job_id = await soaking_job(app)

    printer.start_local("other.3mf", subtask_id="903")
    await app.advance(60)

    assert (await app.job(job_id)).status != "preheating"
    assert printer.sent("project_file") == []


async def test_heaters_stay_on_for_a_print_started_after_an_interrupted_soak(app):
    printer, job_id = await soaking_job(app)
    await app.shutdown()
    printer.report.update(gcode_state="RUNNING", gcode_file="other.3mf", subtask_name="other", subtask_id="904")
    printer.sd["/other.3mf"] = sliced_3mf()

    await app.boot()
    await app.advance(120)
    assert "M140 S0" not in gcode(printer)  # Never cool a print in progress.

    printer.finish()
    await app.advance(60)
    assert "M140 S0" in gcode(printer)


async def test_heater_shutdown_is_retried_until_the_printer_reports_it(app):
    printer, job_id = await soaking_job(app)
    printer.disconnect()
    await app.action(job_id, "stop")
    await app.run()
    assert "M140 S0" not in gcode(printer)

    printer.push()  # Back online.
    await app.advance(60)

    assert "M140 S0" in gcode(printer)
    assert printer.report["bed_target_temper"] == 0


async def test_a_long_upload_after_the_soak_is_not_reported_as_an_interrupted_soak(app):
    printer, job_id = await soaking_job(app)
    printer.upload_gate = asyncio.Event()
    await app.advance(9 * 60)
    running = app.spawn(app.advance(2 * 60))
    await app.until(lambda: printer.uploading, attempts=1000)

    await app.advance(5 * 60)  # A slow upload.
    assert not (await app.job(job_id)).error_message
    printer.upload_gate.set()
    await running
    await app.run()

    assert (await app.job(job_id)).status == "printing"


async def test_deleting_the_file_during_the_soak_ends_it_and_cools_the_printer(app):
    printer = await app.add_printer(model="H2D")
    file_id = await app.add_file()
    job_id = await app.queue(printer, file_id, **SOAK)
    await app.run()

    response = await app.http.delete(f"/library/files/{file_id}")
    assert response.status_code == 200, response.text
    await app.run()
    assert (await app.job(job_id)).status == "preheating"  # The trash can still restore it.

    response = await app.http.delete(f"/library/trash/{file_id}")
    assert response.status_code == 200, response.text
    await app.run()

    assert (await app.job(job_id)).status == "cancelled"
    assert "M140 S0" in gcode(printer)


async def test_a_file_lost_during_the_soak_fails_the_dispatch_and_cools_the_printer(app):
    import os

    printer = await app.add_printer(model="H2D")
    job_id = await app.queue(printer, await app.add_file("lost.3mf"), **SOAK)
    await app.run()
    os.remove(app.tmp_path / "library" / "lost.3mf")

    await app.advance(11 * 60)

    job = await app.job(job_id)
    assert job.status == "failed"
    assert job.error_message
    assert printer.sent("project_file") == []
    assert "M140 S0" in gcode(printer)


async def test_an_any_machine_soak_holds_the_printer_it_was_given(app):
    printer = await app.add_printer(model="H2D")
    job_id = await app.queue(None, await app.add_file(), target_model="H2D", **SOAK)

    await app.run()

    job = await app.job(job_id)
    assert (job.status, job.printer_id) == ("preheating", printer.printer_id)
    await app.advance(11 * 60)
    assert (await app.job(job_id)).status == "printing"


async def test_telemetry_lost_after_the_soak_retries_as_a_fresh_heat_soak(app):
    printer, job_id = await soaking_job(app)
    printer.upload_gate = asyncio.Event()
    await app.advance(9 * 60)
    running = app.spawn(app.advance(2 * 60))
    await app.until(lambda: printer.uploading, attempts=1000)

    printer.disconnect()
    printer.upload_gate.set()
    await running
    printer.push()  # Back, idle, but the attempt already gave up.
    await app.advance(60)

    job = await app.job(job_id)
    assert job.status == "failed" and job.physical_outcome is None
    assert printer.sent("project_file") == []
    assert "M140 S0" in gcode(printer)
    from sqlalchemy import select

    from backend.app.models.print_queue import PrintQueueItem

    async with app.session() as db:
        retries = list(await db.scalars(select(PrintQueueItem).where(PrintQueueItem.id != job_id)))
    assert len(retries) == 1 and retries[0].status == "preheating" and retries[0].retry_on_failure is False
