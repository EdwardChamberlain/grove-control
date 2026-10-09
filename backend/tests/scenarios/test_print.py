"""A queued job prints, completes and frees its printer."""

import pytest


async def set_setting(app, key: str, value: str) -> None:
    from backend.app.models.settings import Settings

    async with app.session() as db:
        db.add(Settings(key=key, value=value))
        await db.commit()


async def printing_job(app, **options):
    printer = await app.add_printer()
    job_id = await app.queue(printer, await app.add_file(), **options)
    await app.run()
    assert (await app.job(job_id)).status == "printing"
    return printer, job_id


async def test_queued_job_prints_and_holds_until_the_plate_is_cleared(app):
    printer = await app.add_printer()
    job_id = await app.queue(printer, await app.add_file())

    await app.run()

    assert len(printer.sent("project_file")) == 1
    assert (await app.job(job_id)).status == "printing"
    uploaded = [name for name in printer.sd if name.endswith(".3mf")]
    assert len(uploaded) == 1

    printer.finish()
    await app.run()
    job = await app.job(job_id)
    assert job.status == "finished"
    assert job.physical_outcome == "completed"
    archive = next(a for a in await app.archives() if a.id == job.archive_id)
    assert archive.status == "completed"
    assert uploaded[0] not in printer.sd  # Completion removes the attempt's upload.

    response = await app.action(job_id, "clear-plate")
    assert response.status_code == 200, response.text
    assert (await app.job(job_id)).status == "successful"


async def test_finished_print_clears_itself_when_plate_confirmation_is_off(app):
    await set_setting(app, "require_plate_clear", "false")
    printer, job_id = await printing_job(app)

    printer.finish()
    await app.run()

    assert (await app.job(job_id)).status == "successful"


async def test_next_job_waits_for_the_plate_then_prints(app):
    printer = await app.add_printer()
    file_id = await app.add_file()
    first = await app.queue(printer, file_id)
    second = await app.queue(printer, file_id)
    await app.run()
    assert [(await app.job(first)).status, (await app.job(second)).status] == ["printing", "queued"]

    printer.finish()
    await app.run()
    assert (await app.job(second)).status == "queued"

    await app.action(first, "clear-plate")
    printer.idle()
    await app.run()
    assert (await app.job(second)).status == "printing"
    assert len(printer.sent("project_file")) == 2


async def test_printer_failure_holds_the_printer_as_failed(app):
    printer, job_id = await printing_job(app)

    printer.fail()
    await app.run()

    job = await app.job(job_id)
    assert job.status == "failed"
    assert job.physical_outcome == "failed"
    await app.action(job_id, "clear-plate")
    assert (await app.job(job_id)).status == "unsuccessful"


async def test_pause_and_resume_follow_the_printer(app):
    printer, job_id = await printing_job(app)

    printer.push(gcode_state="PAUSE")
    await app.run()
    assert (await app.job(job_id)).status == "paused"

    printer.push(gcode_state="RUNNING")
    await app.run()
    assert (await app.job(job_id)).status == "printing"

    printer.finish()
    await app.run()
    assert (await app.job(job_id)).status == "finished"


async def test_a_print_paused_at_completion_still_finishes(app):
    printer, job_id = await printing_job(app)
    printer.push(gcode_state="PAUSE")
    await app.run()

    printer.finish()
    await app.run()

    assert (await app.job(job_id)).status == "finished"


async def test_two_printers_progress_independently(app):
    first, second = await app.add_printer("A"), await app.add_printer("B")
    file_id = await app.add_file()
    a = await app.queue(first, file_id)
    b = await app.queue(second, file_id)
    await app.run()
    assert [(await app.job(a)).status, (await app.job(b)).status] == ["printing", "printing"]

    second.fail()
    await app.run()
    assert [(await app.job(a)).status, (await app.job(b)).status] == ["printing", "failed"]

    first.finish()
    await app.run()
    assert [(await app.job(a)).status, (await app.job(b)).status] == ["finished", "failed"]


@pytest.mark.parametrize("finish", ["finish", "fail"])
async def test_completion_is_announced_once(app, finish):
    printer, job_id = await printing_job(app)

    getattr(printer, finish)()
    await app.run()
    printer.push()  # The printer repeats its final state.
    await app.run()

    assert len(app.notified("on_print_complete")) == 1


async def test_a_print_first_seen_paused_is_recorded_as_paused(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    body = printer.sent("project_file")[-1]
    printer.push(gcode_state="PAUSE", gcode_file="part.3mf", subtask_id=str(body["subtask_id"]), mc_percent=1)
    await app.run()

    assert (await app.job(job_id)).status == "paused"


async def test_an_any_machine_job_prints_on_a_matching_printer(app):
    printer = await app.add_printer(model="X1C")
    job_id = await app.queue(None, await app.add_file(), target_model="X1C")

    await app.run()

    job = await app.job(job_id)
    assert (job.status, job.printer_id) == ("printing", printer.printer_id)
