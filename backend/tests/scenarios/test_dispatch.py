"""Sending a job: uploads, the print command and its confirmation."""

import asyncio

from backend.tests.scenarios.test_print import printing_job


def uploads(printer) -> list[str]:
    return sorted(name for name in printer.sd if name.endswith(".3mf"))


async def test_failed_upload_fails_the_attempt_without_sending(app):
    app.allowed_errors += ["FTP upload", "Upload print"]
    printer = await app.add_printer()
    printer.accepts_uploads = False
    job_id = await app.queue(printer, await app.add_file())

    await app.run()

    job = await app.job(job_id)
    assert job.status == "failed"
    assert job.error_message
    assert printer.sent("project_file") == []
    assert uploads(printer) == []


async def test_lost_print_command_is_held_for_review_then_resolved(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())

    await app.run()
    assert len(printer.sent("project_file")) == 1
    assert (await app.job(job_id)).status == "dispatching"

    await app.advance(300)
    job = await app.job(job_id)
    assert job.status == "dispatching"
    assert job.error_message

    response = await app.action(job_id, "resolve-dispatch", outcome="failed")
    assert response.status_code == 200, response.text
    assert (await app.job(job_id)).status == "failed"


async def test_late_start_confirms_the_dispatch(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    printer._start(printer.sent("project_file")[-1])
    await app.run()

    assert (await app.job(job_id)).status == "printing"


async def test_telemetry_lost_before_sending_sends_nothing_and_offers_retry(app):
    printer = await app.add_printer()
    printer.upload_gate = asyncio.Event()
    job_id = await app.queue(printer, await app.add_file())
    running = app.spawn(app.run())
    await app.until(lambda: printer.uploading)

    printer.disconnect()
    printer.upload_gate.set()
    await running
    await app.advance(60)

    job = await app.job(job_id)
    assert job.status == "dispatching"
    assert printer.sent("project_file") == []

    response = await app.action(job_id, "retry")
    assert response.status_code == 200, response.text
    assert (await app.job(job_id)).status == "unsuccessful"
    retried = response.json()["id"]
    printer.upload_gate = None
    printer.push()  # The printer comes back.
    await app.run()
    assert (await app.job(retried)).status == "printing"


async def test_retry_after_a_failure_prints_once_the_plate_is_cleared(app):
    printer, job_id = await printing_job(app)
    printer.fail()
    await app.run()

    response = await app.action(job_id, "retry")
    assert response.status_code == 200, response.text
    retried = response.json()["id"]
    await app.run()
    assert (await app.job(retried)).status == "queued"

    await app.action(job_id, "clear-plate")
    printer.idle()
    await app.run()
    assert (await app.job(retried)).status == "printing"


async def test_restart_during_upload_fails_the_unsent_attempt(app):
    printer = await app.add_printer()
    printer.upload_gate = asyncio.Event()
    job_id = await app.queue(printer, await app.add_file())
    app.spawn(app.run())
    await app.until(lambda: printer.uploading)

    await app.restart(abrupt=True)
    printer.upload_gate = None
    await app.run()

    job = await app.job(job_id)
    assert job.status == "failed"
    assert printer.sent("project_file") == []


async def test_restart_after_sending_keeps_the_job_until_the_printer_reports(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    await app.restart()
    await app.run()
    assert (await app.job(job_id)).status == "dispatching"

    printer._start(printer.sent("project_file")[-1])
    await app.run()
    assert (await app.job(job_id)).status == "printing"


async def test_each_attempt_uploads_its_own_file_and_completion_removes_only_that(app):
    printer = await app.add_printer()
    file_id = await app.add_file()
    first = await app.queue(printer, file_id)
    second = await app.queue(printer, file_id)
    await app.run()
    first_upload = uploads(printer)
    assert len(first_upload) == 1
    printer.sd["/keep.3mf"] = b"the user's own file"

    printer.finish()
    await app.run()
    assert first_upload[0] not in printer.sd
    assert "/keep.3mf" in printer.sd

    await app.action(first, "clear-plate")
    printer.idle()
    await app.run()
    assert (await app.job(second)).status == "printing"
    second_upload = [name for name in uploads(printer) if name != "/keep.3mf"]
    assert len(second_upload) == 1
    assert second_upload != first_upload
