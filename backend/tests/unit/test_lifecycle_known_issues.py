"""The behaviour fixes #204 left for after its restructure: stale prints, unsent attempts and unresolved trays."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.ams_mapping import unresolved
from backend.app.services.lifecycle import dispatching
from backend.app.services.lifecycle.engine import InvalidQueueTransition, transition_queue_item
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_selection import PrinterSelection
from backend.app.services.queue_actions import cancel_job
from backend.tests.unit.test_queue_archive_alignment import alignment, hold_and_link  # noqa: F401


def live(state: str, identity: str):
    return SimpleNamespace(
        connected=True,
        job_telemetry_ready=True,
        state=state,
        submission_id=identity,
        gcode_file="next.gcode",
        subtask_name="next",
        raw_data={"gcode_state": state},
    )


async def printing_job(db, alignment, identity: str = "111", **values) -> PrintQueueItem:
    job = await db.get(PrintQueueItem, alignment.job_id)
    job.auto_off_after = True
    await transition_queue_item(db, job, "queued", "dispatching", values={"dispatch_subtask_id": identity, **values})
    await transition_queue_item(db, job, "dispatching", "printing")
    await db.commit()
    return job


@pytest.mark.parametrize("state", ["RUNNING", "FINISH"])
async def test_recovery_ends_a_print_the_printer_has_replaced(alignment, monkeypatch, state):
    """A different live print ID proves the old print ended while Grove wasn't watching (#204)."""
    observe = AsyncMock()
    monkeypatch.setattr("backend.app.services.lifecycle.intake.print_started", observe)
    monkeypatch.setattr(dispatching.printer_manager, "get_status", lambda _: live(state, "222"))
    async with alignment.sessions() as db:
        job = await printing_job(db, alignment)
        await PrintScheduler().dispatcher.recover(db)
        await db.refresh(job)
        assert job.status == "failed" and "222" in job.error_message
        assert job.auto_off_after is False  # Auto Off would power off the print that replaced it.
    await asyncio.sleep(0.01)
    if state == "RUNNING":
        observe.assert_awaited_once()
        assert observe.await_args.args[1]["submission_id"] == "222"
    else:
        observe.assert_not_awaited()


async def test_recovery_leaves_a_replaced_print_to_its_completion_in_flight(alignment, monkeypatch):
    from backend.app.services.lifecycle import intake

    monkeypatch.setattr(dispatching.printer_manager, "get_status", lambda _: live("RUNNING", "222"))
    async with alignment.sessions() as db:
        job = await printing_job(db, alignment)
        async with intake._lock(job.printer_id):  # The printer's completion event is being processed.
            await PrintScheduler().dispatcher.recover(db)
        await db.refresh(job)
        assert job.status == "printing"


@pytest.mark.parametrize(
    "ours,theirs,state",
    [("111", "111", "RUNNING"), ("111", "222", "IDLE"), ("a" * 32, "222", "RUNNING"), ("111", "b" * 32, "RUNNING")],
)
async def test_recovery_keeps_a_print_nothing_proves_has_ended(alignment, monkeypatch, ours, theirs, state):
    """The same ID, an idle printer, or a session-local ID on either side proves nothing."""
    monkeypatch.setattr(dispatching.printer_manager, "get_status", lambda _: live(state, theirs))
    async with alignment.sessions() as db:
        job = await printing_job(db, alignment, ours)
        await PrintScheduler().dispatcher.recover(db)
        await db.refresh(job)
        assert job.status == "printing"


@pytest.mark.parametrize("theirs", ["111", "222"])
async def test_stop_sends_the_stop_command_only_for_its_own_print(alignment, monkeypatch, theirs):
    from backend.app.services.printer_manager import printer_manager

    stop = MagicMock(return_value=True)
    monkeypatch.setattr(printer_manager, "stop_print", stop)
    monkeypatch.setattr(printer_manager, "get_status", lambda _: live("RUNNING", theirs))
    async with alignment.sessions() as db:
        job = await printing_job(db, alignment)
        await cancel_job(db, job)
        await db.refresh(job)
        assert job.status == "cancelled"
    if theirs == "111":
        stop.assert_called_once()
        assert job.error_message == "Stop requested by user" and job.auto_off_after
    else:
        stop.assert_not_called()  # It would stop the other print.
        assert "different print (222)" in job.error_message and job.auto_off_after is False


async def test_retry_withdraws_an_attempt_nothing_was_sent_for(alignment):
    from backend.app.api.routes.print_queue import retry_queue_item

    async with alignment.sessions() as db:
        old = await db.get(PrintQueueItem, alignment.job_id)
        await hold_and_link(db, old)
        old.error_message = dispatching._TELEMETRY_UNAVAILABLE
        await db.commit()
        assert dispatching.unsent(old)
        result = await retry_queue_item(old.id, db=db, auth_result=(None, True), _=None)
        await db.refresh(old)
        new = await db.get(PrintQueueItem, result.id)
        assert old.status == "unsuccessful" and new.status == "queued"
        assert new.library_file_id == old.library_file_id  # The retry keeps its source.


async def test_only_an_unsent_attempt_is_withdrawn(alignment):
    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        await transition_queue_item(db, job, "queued", "dispatching", values={"dispatch_subtask_id": "111"})
        await db.commit()
        with pytest.raises(InvalidQueueTransition):
            await PrintScheduler().dispatcher.withdraw(db, job)
        with pytest.raises(InvalidQueueTransition):  # Nor through the engine, for any other reason.
            await transition_queue_item(db, job, "dispatching", "unsuccessful", action="cancel")


@pytest.mark.parametrize(
    "mapping,expected",
    [("[-1]", True), ([-1, None], True), ("[-1, 3]", False), ("[254]", False), ("[]", False), (None, False)],
)
def test_unresolved_means_no_slot_maps_to_a_tray(mapping, expected):
    assert unresolved(mapping) is expected


@pytest.mark.parametrize("computed,bound", [([2], "[2]"), ([-1], None), (None, None)])
async def test_a_stored_unresolved_mapping_is_recomputed_or_held(computed, bound):
    """A stored [-1] is never sent: it's recomputed, or the job waits (#2589)."""
    mapping = SimpleNamespace(
        _ams_mapping_uses_compatible_materials=lambda *_: True,
        _compute_ams_mapping_for_printer=AsyncMock(return_value=computed),
        _get_missing_force_mapping_slots=lambda *_: [],
    )
    selection = PrinterSelection(mapping, drying=None)
    item, db = SimpleNamespace(id=1, ams_mapping=json.dumps([-1]), waiting_reason=None), AsyncMock()
    mapped, result = await selection._bind_mapping(db, item, 1, [], [])
    assert (mapped, result) == (bound is not None, bound)
    assert (item.waiting_reason is None) is (bound is not None)
