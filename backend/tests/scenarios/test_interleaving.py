"""Racing inputs in a seeded random order: the one-writer rule must hold and the printer must stay usable.

Each seed fires a random mix of user actions, printer reports and the app's
periodic work concurrently at one printing job. The fixture already fails on
any conflict, late lock or logged error; this adds the outcome invariants.
Set ``SCENARIO_SEEDS`` to run more seeds.
"""

import asyncio
import os
import random

import pytest

from backend.tests.scenarios.test_print import printing_job

SEEDS = range(int(os.environ.get("SCENARIO_SEEDS", "40")))
HOLDING = {"preheating", "dispatching", "printing", "paused", "finished", "failed", "cancelled"}


async def _jitter(rng: random.Random) -> None:
    for _ in range(rng.randrange(6)):
        await asyncio.sleep(0)


@pytest.mark.parametrize("seed", SEEDS)
async def test_racing_inputs_keep_one_writer_and_a_usable_printer(app, seed):
    rng = random.Random(seed)
    printer, job_id = await printing_job(app)

    async def report(change):
        await _jitter(rng)
        change()

    async def call(name):
        await _jitter(rng)
        await app.action(job_id, name)

    async def periodic():
        await _jitter(rng)
        await app.run(rounds=1)

    inputs = {
        "stop": lambda: call("stop"),
        "finish": lambda: report(printer.finish),
        "fail": lambda: report(printer.fail),
        "pause": lambda: report(printer.pause),
        "resume": lambda: report(printer.resume),
        "reconnect": lambda: report(lambda: (printer.disconnect(), printer.push())),
        "clear": lambda: call("clear-plate"),
        "periodic": periodic,
    }
    chosen = rng.sample(sorted(inputs), rng.randrange(2, len(inputs) + 1))
    tasks = [app.spawn(inputs[name]()) for name in chosen]
    await asyncio.gather(*tasks)
    await app.run()

    job = await app.job(job_id)
    assert len(printer.sent("project_file")) == 1, chosen
    assert len(app.notified("on_print_complete")) <= 1, chosen
    holding = [j for j in await app.jobs(printer) if j.status in HOLDING]
    assert len(holding) <= 1, chosen

    # Whatever happened, the printer can be freed and print the next job.
    if job.status in ("printing", "paused"):
        printer.finish()
        await app.run()
        job = await app.job(job_id)
    if job.status in HOLDING:
        response = await app.action(job_id, "clear-plate")
        assert response.status_code == 200, (chosen, job.status, response.text)
    printer.idle()
    following = await app.queue(printer, await app.add_file("next.3mf"))
    await app.run()
    assert (await app.job(following)).status == "printing", chosen


@pytest.mark.parametrize("seed", SEEDS)
async def test_racing_inputs_during_a_heat_soak(app, seed):
    from backend.tests.scenarios.test_soak import SOAK, gcode

    rng = random.Random(seed)
    printer = await app.add_printer(model="H2D")
    job_id = await app.queue(printer, await app.add_file(), **SOAK)
    await app.run()
    assert (await app.job(job_id)).status == "preheating"

    async def call(name):
        await _jitter(rng)
        await app.action(job_id, name)

    async def soak_ends():
        await _jitter(rng)
        await app.advance(11 * 60, tick=60)

    async def blip():
        await _jitter(rng)
        printer.disconnect()
        printer.push()

    inputs = {
        "stop": lambda: call("stop"),
        "skip": lambda: call("skip-heat-soak"),
        "soak_ends": soak_ends,
        "blip": blip,
        "periodic": lambda: app.run(rounds=1),
    }
    chosen = rng.sample(sorted(inputs), rng.randrange(2, len(inputs) + 1))
    await asyncio.gather(*(app.spawn(inputs[name]()) for name in chosen))
    await app.run()

    job = await app.job(job_id)
    sent = len(printer.sent("project_file"))
    assert sent <= 1, chosen
    if job.status in ("cancelled", "failed"):
        assert "M140 S0" in gcode(printer), (chosen, job.status)
    if sent:
        assert job.status in ("printing", "cancelled", "failed"), (chosen, job.status)


@pytest.mark.parametrize("seed", SEEDS)
async def test_stop_racing_a_dispatch(app, seed):
    """Stop lands anywhere from upload to confirmation: nothing prints unstopped, and no upload outlives the job."""
    rng = random.Random(seed)
    printer = await app.add_printer()
    printer.upload_gate = asyncio.Event()
    job_id = await app.queue(printer, await app.add_file())
    running = app.spawn(app.run())
    if seed % 2:  # Otherwise Stop may land before the hold or during the Archive copy.
        await app.until(lambda: printer.uploading)

    async def release():
        await _jitter(rng)
        printer.upload_gate.set()

    async def stop():
        for _ in range(rng.randrange(40)):
            await asyncio.sleep(0)
        await app.action(job_id, "stop")

    await asyncio.gather(app.spawn(release()), app.spawn(stop()))
    await running
    await app.run()

    job = await app.job(job_id)
    assert job.status in ("cancelled", "unsuccessful"), job.status
    if printer.sent("project_file"):
        assert printer.sent("stop"), "a print was sent after Stop without a Stop command"
    if job.status == "cancelled":
        # Stop after the send boundary keeps the hold: a person confirms the plate first.
        assert (await app.action(job_id, "clear-plate")).status_code == 200
        await app.run()
    assert not [name for name in printer.sd if name.endswith(".3mf")], "an upload outlived its attempt"
    job = await app.job(job_id)
    archives = await app.archives()
    assert all(a.id == job.archive_id for a in archives), "an Archive copy was left unlinked"
    files = list((app.tmp_path / "archives").rglob("*.3mf"))
    assert len(files) == len([a for a in archives if a.file_path]), "an Archive file outlived its row"


@pytest.mark.parametrize("seed", SEEDS)
async def test_an_edit_racing_selection_is_never_dispatched_stale(app, seed):
    """An edit the API accepted while the job waited always wins over the scheduler's earlier decision."""
    rng = random.Random(seed)
    printer = await app.add_printer()
    job_id = await app.queue(printer, await app.add_file())

    async def edit():
        await _jitter(rng)
        return await app.http.patch(f"/queue/{job_id}", json={"manual_start": True})

    running = app.spawn(app.run(rounds=1))
    response = await app.spawn(edit())
    await running
    await app.run()

    job = await app.job(job_id)
    if response.status_code == 200:
        assert job.status == "queued", "an accepted edit was dispatched with the stale decision"
        assert printer.sent("project_file") == []
    else:
        assert job.status == "printing"
