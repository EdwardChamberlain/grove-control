"""Prints the printer started itself, from its touchscreen or SD card."""

from backend.tests.scenarios.test_print import printing_job


async def test_touchscreen_print_with_a_firmware_id_becomes_an_ownerless_job(app):
    printer = await app.add_printer()

    printer.start_local("bracket.3mf", subtask_id="555")
    await app.run()
    [job] = await app.jobs(printer)
    assert job.status == "printing"
    assert job.created_by_id is None

    printer.finish()
    await app.run()
    assert (await app.job(job.id)).status == "finished"
    assert [a.status for a in await app.archives()] == ["completed"]


async def test_sd_print_without_a_firmware_id_is_still_tracked(app):
    printer = await app.add_printer()

    printer.start_local("bracket.3mf", subtask_id="0")
    await app.run()
    [job] = await app.jobs(printer)
    assert job.status == "printing"

    printer.finish()
    await app.run()
    assert (await app.job(job.id)).status == "finished"


async def test_a_late_firmware_id_keeps_the_same_job(app):
    printer = await app.add_printer()
    printer.start_local("bracket.3mf", subtask_id="0")
    await app.run()

    printer.push(subtask_id="556")
    await app.run()
    printer.finish()
    await app.run()

    [job] = await app.jobs(printer)
    assert job.status == "finished"
    assert job.dispatch_subtask_id == "556"


async def test_touchscreen_print_on_a_held_printer_takes_over_the_hold(app):
    printer, job_id = await printing_job(app)
    printer.finish()
    await app.run()
    assert (await app.job(job_id)).status == "finished"

    printer.idle()
    printer.start_local("bracket.3mf", subtask_id="557")
    await app.run()

    assert (await app.job(job_id)).status == "successful"
    [*_, external] = await app.jobs(printer)
    assert external.id != job_id
    assert external.status == "printing"
