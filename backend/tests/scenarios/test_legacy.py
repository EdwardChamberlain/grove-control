"""Prints archived by a version before every print had a job (#194)."""

from backend.tests.scenarios.fake_printer import sliced_3mf


async def legacy_print(app, printer, identity: str, state: str) -> None:
    """While the app is down, an older version's Archive records a print the printer is running or has ended."""
    from backend.app.models.archive import PrintArchive

    await app.shutdown()
    async with app.session() as db:
        db.add(
            PrintArchive(
                printer_id=printer.printer_id,
                filename="old.3mf",
                file_path="",
                file_size=0,
                status="printing",
                subtask_id=identity,
            )
        )
        await db.commit()
    printer.sd["/old.3mf"] = sliced_3mf()
    printer.report.update(gcode_state=state, gcode_file="old.3mf", subtask_name="old", subtask_id=identity)
    await app.boot()
    await app.run()


async def test_a_legacy_print_that_finished_while_down_ends_as_a_finished_job(app):
    printer = await app.add_printer()
    await legacy_print(app, printer, "700", "FINISH")

    [job] = await app.jobs(printer)
    assert job.status == "finished"
    [archive] = await app.archives()
    assert (archive.status, job.archive_id) == ("completed", archive.id)
    assert (await app.action(job.id, "clear-plate")).status_code == 200


async def test_a_legacy_print_still_running_finishes_as_a_job(app):
    printer = await app.add_printer()
    await legacy_print(app, printer, "701", "RUNNING")

    [job] = await app.jobs(printer)
    assert job.status == "printing"
    printer.finish()
    await app.run()

    assert (await app.job(job.id)).status == "finished"
    [archive] = await app.archives()
    assert archive.status == "completed"
