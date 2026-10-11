"""Stop and Cancel from every state."""

import asyncio

from backend.tests.scenarios.test_print import printing_job


async def test_cancel_a_waiting_job(app):
    printer = await app.add_printer()
    printer.start_local("busy.3mf", subtask_id="900")  # Keeps the job waiting.
    await app.run()
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    response = await app.action(job_id, "cancel")

    assert response.status_code == 200, response.text
    assert (await app.job(job_id)).status == "unsuccessful"
    assert printer.sent("stop") == []


async def test_stop_while_printing_sends_stop_and_records_a_user_cancel(app):
    printer, job_id = await printing_job(app)

    response = await app.action(job_id, "stop")
    assert response.status_code == 200, response.text
    assert (await app.job(job_id)).status == "cancelled"
    assert len(printer.sent("stop")) == 1

    await app.run()  # The printer reports the stopped print as FAILED.
    job = await app.job(job_id)
    assert job.status == "cancelled"
    assert job.physical_outcome == "aborted"
    assert (await app.action(job_id, "clear-plate")).status_code == 200
    assert (await app.job(job_id)).status == "unsuccessful"


async def test_stop_while_paused(app):
    printer, job_id = await printing_job(app)
    printer.push(gcode_state="PAUSE")
    await app.run()

    await app.action(job_id, "stop")
    await app.run()

    assert (await app.job(job_id)).status == "cancelled"
    assert len(printer.sent("stop")) == 1


async def test_stop_while_offline_keeps_the_hold_until_the_plate_is_cleared(app):
    printer, job_id = await printing_job(app)
    printer.disconnect()
    await app.settle()

    await app.action(job_id, "stop")
    await app.run()

    job = await app.job(job_id)
    assert job.status == "cancelled"
    assert job.error_message
    assert (await app.action(job_id, "clear-plate")).status_code == 200
    assert (await app.job(job_id)).status == "unsuccessful"


async def test_a_print_that_finishes_despite_stop_is_recorded_as_finished(app):
    printer, job_id = await printing_job(app)
    printer.accepts_stop = False

    await app.action(job_id, "stop")
    printer.finish()
    await app.run()

    job = await app.job(job_id)
    assert job.status == "finished"
    assert job.physical_outcome == "completed"


async def test_stop_during_upload_removes_the_upload_and_sends_nothing(app):
    printer = await app.add_printer()
    printer.upload_gate = asyncio.Event()
    job_id = await app.queue(printer, await app.add_file())
    running = app.spawn(app.run())
    await app.until(lambda: printer.uploading)

    stop = app.spawn(app.action(job_id, "stop"))
    await app.until(lambda: _status(app, job_id, "unsuccessful"))
    printer.upload_gate.set()
    assert (await stop).status_code == 200
    await running
    await app.run()

    assert (await app.job(job_id)).status == "unsuccessful"
    assert printer.sent("project_file") == []
    assert printer.sent("stop") == []  # Nothing was sent, so nothing is stopped.
    assert not [name for name in printer.sd if name.endswith(".3mf")]


async def _status(app, job_id, status):
    return (await app.job(job_id)).status == status


async def test_stop_refuses_to_stop_a_different_print(app):
    printer, job_id = await printing_job(app)
    await app.restart()
    # While the app was down the printer finished and started a touchscreen print.
    printer.start_local("other.3mf", subtask_id="777")

    await app.action(job_id, "stop")
    await app.run()

    assert printer.sent("stop") == []
