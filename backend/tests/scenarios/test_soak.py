"""Chamber heat soak before a print, on a printer with a chamber heater."""

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

    assert (await app.job(job_id)).status == "cancelled"
    assert "M140 S0" in gcode(printer)
    assert "M141 S0" in gcode(printer)
    assert printer.sent("project_file") == []


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
    assert (await app.job(job_id)).status == "cancelled"


async def test_printer_lost_during_soak_ends_the_soak(app):
    printer, job_id = await soaking_job(app)

    printer.disconnect()
    await app.advance(60)

    assert (await app.job(job_id)).status == "failed"
    assert printer.sent("project_file") == []
