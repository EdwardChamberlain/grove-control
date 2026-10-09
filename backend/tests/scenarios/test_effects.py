"""What the lifecycle asks of the outside world: Archives, Auto Off and notifications."""

import asyncio

import pytest

from backend.tests.scenarios.fake_printer import sliced_3mf
from backend.tests.scenarios.test_print import printing_job


def plug_offs(app, printer) -> list:
    return [e for e in app.plug_events if e.event == "schedule_off_after_queue_job" and printer.printer_id in e.args]


async def test_auto_off_is_requested_once_after_the_job(app):
    printer, job_id = await printing_job(app, auto_off_after=True)

    printer.finish()
    await app.run()

    assert len(plug_offs(app, printer)) == 1


async def test_auto_off_is_requested_once_after_a_failed_job(app):
    printer, job_id = await printing_job(app, auto_off_after=True)

    printer.fail()
    await app.run()

    assert len(plug_offs(app, printer)) == 1


async def test_auto_off_is_requested_once_after_stop(app):
    printer, job_id = await printing_job(app, auto_off_after=True)

    await app.action(job_id, "stop")
    await app.run()

    assert len(plug_offs(app, printer)) == 1


async def test_no_auto_off_without_the_option(app):
    printer, job_id = await printing_job(app)

    printer.finish()
    await app.run()

    assert plug_offs(app, printer) == []


async def test_no_auto_off_when_a_new_print_superseded_the_job(app):
    printer, job_id = await printing_job(app, auto_off_after=True)
    await app.shutdown()
    printer.sd["/other.3mf"] = sliced_3mf()
    printer.report.update(gcode_state="RUNNING", gcode_file="other.3mf", subtask_name="other", subtask_id="779")

    await app.boot()
    await app.run()

    assert plug_offs(app, printer) == []


async def test_failure_notice_for_a_failed_upload(app):
    app.allowed_errors += ["FTP upload", "Upload print"]
    printer = await app.add_printer()
    printer.accepts_uploads = False
    await app.queue(printer, await app.add_file())

    await app.run()

    # The original job creates one fresh retry; both failed attempts notify,
    # while the retry's flag prevents an endless chain.
    assert len(app.notified("on_queue_job_failed")) == 2
    from sqlalchemy import select

    from backend.app.models.print_queue import PrintQueueItem

    async with app.session() as db:
        jobs = list(await db.scalars(select(PrintQueueItem).order_by(PrintQueueItem.id)))
    assert len(jobs) == 2
    assert sorted(job.retry_on_failure for job in jobs) == [False, True]


async def test_archive_is_repaired_once_the_file_appears(app):
    printer = await app.add_printer()
    printer.start_local("late.3mf", subtask_id="560", on_sd=False)
    await app.run()
    [job] = await app.jobs(printer)
    assert job.status == "printing"

    printer.sd["/late.3mf"] = sliced_3mf()
    await app.advance(120)

    job = await app.job(job.id)
    assert job.archive_id is not None
    printer.finish()
    await app.run()
    archive = next(a for a in await app.archives() if a.id == job.archive_id)
    assert archive.status == "completed"


@pytest.mark.parametrize(
    "ending, status, archived", [("finish", "finished", "completed"), ("fail", "failed", "failed")]
)
@pytest.mark.parametrize("cleared_first", [False, True])
async def test_an_ending_during_the_start_download_still_records_the_archive(
    app, ending, status, archived, cleared_first
):
    printer = await app.add_printer()
    printer.download_gate = asyncio.Event()
    printer.start_local("slow.3mf", subtask_id="561")
    running = app.spawn(app.run())
    await app.until(lambda: printer.downloading)

    getattr(printer, ending)()
    if cleared_first:  # The loop records the outcome, and the person clears the plate, before the download ends.
        await app.tick(30)
        await app.until(lambda: _ended(app, printer, status))
        [job] = await app.jobs(printer)
        assert (await app.action(job.id, "clear-plate")).status_code == 200
    printer.download_gate.set()
    await running
    await app.run()

    [job] = await app.jobs(printer)
    assert job.status == ({"finished": "successful", "failed": "unsuccessful"}[status] if cleared_first else status)
    assert job.archive_id is not None
    archive = next(a for a in await app.archives() if a.id == job.archive_id)
    assert archive.status == archived


async def _ended(app, printer, status):
    jobs = await app.jobs(printer)
    return bool(jobs) and jobs[0].status == status
