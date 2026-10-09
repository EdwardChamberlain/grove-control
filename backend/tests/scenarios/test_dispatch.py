"""Sending a job: uploads, the print command and its confirmation."""

import asyncio

from backend.tests.scenarios.fake_printer import sliced_3mf
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


async def test_restart_during_upload_parks_the_unsent_attempt_for_retry(app):
    printer = await app.add_printer()
    printer.upload_gate = asyncio.Event()
    job_id = await app.queue(printer, await app.add_file())
    app.spawn(app.run())
    await app.until(lambda: printer.uploading)

    await app.restart(abrupt=True)
    printer.upload_gate = None
    await app.run()

    job = await app.job(job_id)
    assert (job.status, bool(job.error_message)) == ("dispatching", True)
    assert printer.sent("project_file") == []

    # Nothing was sent, so Retry releases the printer without a plate check.
    response = await app.action(job_id, "retry")
    assert response.status_code == 200, response.text
    assert (await app.job(job_id)).status == "unsuccessful"
    await app.run()
    assert (await app.job(response.json()["id"])).status == "printing"


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


async def test_a_print_id_that_lands_without_starting_is_held_for_review_without_reconnecting(app):
    printer = await app.add_printer()
    printer.accepts_prints = "id_only"
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    await app.advance(120)  # Past the first window: the ID landed, so it waits longer.
    assert (await app.job(job_id)).error_message is None
    await app.advance(180)

    job = await app.job(job_id)
    assert (job.status, bool(job.error_message)) == ("dispatching", True)
    assert printer.reconnects == 0


async def test_an_unacknowledged_print_command_resets_the_printer_session(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    await app.queue(printer, await app.add_file())
    await app.run()

    await app.advance(120)

    assert printer.reconnects == 1


async def test_a_different_active_print_never_confirms_the_dispatch(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    printer.start_local("other.3mf", subtask_id="901")  # Someone started another print instead.
    await app.advance(300)

    assert (await app.job(job_id)).status != "printing"


async def test_an_unconfirmed_dispatch_does_not_block_another_printer(app):
    slow, fast = await app.add_printer("Slow"), await app.add_printer("Fast")
    slow.accepts_prints = False
    file_id = await app.add_file()
    stuck = await app.queue(slow, file_id)
    await app.run()

    other = await app.queue(fast, file_id)
    await app.run()

    assert (await app.job(stuck)).status == "dispatching"
    assert (await app.job(other)).status == "printing"


async def test_stop_before_a_late_start_announces_no_start(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    printer.accepts_stop = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    await app.action(job_id, "stop")
    printer._start(printer.sent("project_file")[-1])
    await app.run()

    assert (await app.job(job_id)).status == "cancelled"
    assert app.notified("on_queue_job_started") == []


async def test_restart_after_sending_holds_the_job_when_the_printer_runs_another_print(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    await app.shutdown()
    printer.sd["/other.3mf"] = sliced_3mf()
    printer.report.update(gcode_state="RUNNING", gcode_file="other.3mf", subtask_name="other", subtask_id="902")
    await app.boot()
    await app.advance(300)

    job = await app.job(job_id)
    assert job.status == "dispatching"
    assert job.error_message


async def test_a_file_that_cannot_be_copied_fails_with_its_cause(app):
    import os

    printer = await app.add_printer()
    file_id = await app.add_file("gone.3mf")
    os.remove(app.tmp_path / "library" / "gone.3mf")
    app.allowed_errors += ["failed to copy dispatch Archive"]

    job_id = await app.queue(printer, file_id)
    await app.run()

    job = await app.job(job_id)
    assert (job.status, printer.sent("project_file")) in (("failed", []), ("queued", []))
    assert job.error_message or job.waiting_reason


async def test_a_print_whose_start_was_missed_announces_only_its_end(app):
    printer = await app.add_printer()
    printer.accepts_prints = False
    job_id = await app.queue(printer, await app.add_file())
    await app.run()

    body = printer.sent("project_file")[-1]
    printer.push(gcode_state="FINISH", gcode_file="part.3mf", subtask_id=str(body["subtask_id"]), mc_percent=100)
    await app.run()

    assert (await app.job(job_id)).status == "finished"
    assert app.notified("on_queue_job_started") == []
