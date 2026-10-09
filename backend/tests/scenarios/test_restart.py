"""Restarts and reconnects: the app recovers from what the printer reports."""

from backend.tests.scenarios.fake_printer import sliced_3mf
from backend.tests.scenarios.test_print import printing_job


async def test_restart_while_printing_then_finish(app):
    printer, job_id = await printing_job(app)

    await app.restart()
    await app.run()
    assert (await app.job(job_id)).status == "printing"

    printer.finish()
    await app.run()
    assert (await app.job(job_id)).status == "finished"


async def test_print_that_finished_while_the_app_was_down_is_finished(app):
    printer, job_id = await printing_job(app)
    await app.shutdown()
    printer.report.update(gcode_state="FINISH", mc_percent=100)

    await app.boot()
    await app.run()

    assert (await app.job(job_id)).status == "finished"


async def test_print_that_failed_while_the_app_was_down_is_failed(app):
    printer, job_id = await printing_job(app)
    await app.shutdown()
    printer.report.update(gcode_state="FAILED")

    await app.boot()
    await app.run()

    assert (await app.job(job_id)).status == "failed"


async def test_a_new_print_started_while_the_app_was_down_supersedes_the_old_job(app):
    printer, job_id = await printing_job(app)
    await app.shutdown()
    printer.sd["/other.3mf"] = sliced_3mf()
    printer.report.update(gcode_state="RUNNING", gcode_file="other.3mf", subtask_name="other", subtask_id="778")

    await app.boot()
    await app.run()

    # Its outcome is unknown, so it failed; the new print then took over its hold.
    assert (await app.job(job_id)).status == "unsuccessful"
    [*_, current] = await app.jobs(printer)
    assert current.id != job_id
    assert current.status == "printing"
    assert current.dispatch_subtask_id == "778"


async def test_restart_while_paused_keeps_it_paused(app):
    printer, job_id = await printing_job(app)
    printer.push(gcode_state="PAUSE")
    await app.run()

    await app.restart()
    await app.run()

    assert (await app.job(job_id)).status == "paused"


async def test_restart_while_awaiting_plate_clear_keeps_the_hold(app):
    printer, job_id = await printing_job(app)
    printer.finish()
    await app.run()

    await app.restart()
    await app.run()

    assert (await app.job(job_id)).status == "finished"
    assert (await app.action(job_id, "clear-plate")).status_code == 200
    assert (await app.job(job_id)).status == "successful"


async def test_reconnect_while_printing_then_finish(app):
    printer, job_id = await printing_job(app)

    printer.disconnect()
    await app.run()
    assert (await app.job(job_id)).status == "printing"

    printer.push()
    printer.finish()
    await app.run()
    assert (await app.job(job_id)).status == "finished"


async def test_print_finished_during_a_disconnect_is_finished_on_reconnect(app):
    printer, job_id = await printing_job(app)
    printer.disconnect()
    await app.run()

    printer.report.update(gcode_state="FINISH", mc_percent=100)
    printer.push()
    await app.run()

    assert (await app.job(job_id)).status == "finished"


async def test_restart_while_failed_keeps_the_hold(app):
    printer, job_id = await printing_job(app)
    printer.fail()
    await app.run()

    await app.restart()
    await app.run()

    assert (await app.job(job_id)).status == "failed"


async def test_restart_while_cancelled_keeps_the_hold(app):
    printer, job_id = await printing_job(app)
    await app.action(job_id, "stop")
    await app.run()

    await app.restart()
    await app.run()

    assert (await app.job(job_id)).status == "cancelled"
    assert len(printer.sent("stop")) == 1
