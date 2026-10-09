"""Stage 2: real job matching, external observations, recovery and user resolution."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.api.routes.print_queue import clear_queue_plate, resolve_queue_dispatch, stop_queue_item
from backend.app.core.database import Base, _migrate_queue_lifecycle
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.schemas.print_queue import DispatchResolution
from backend.app.services.job_identity import event_identity, find_job, needs_dispatch_resolution
from backend.app.services.lifecycle.engine import HOLDING_STATUSES, transition_queue_item
from backend.app.services.lifecycle.printing import bind_observed_id, observe_print
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_manager import PrinterManager


@pytest.fixture
async def sessions(tmp_path):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    intake._completed_job_events.clear()
    intake._started_job_effects.clear()
    intake._user_stopped_printers.clear()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'jobs.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate_queue_lifecycle(conn)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(Printer(id=1, name="Printer", serial_number="TEST", ip_address="127.0.0.1", access_code="12345678"))
        await db.commit()
    yield maker
    intake._user_stopped_printers.clear()
    await engine.dispose()


async def add_job(sessions, status="dispatching", **kwargs):
    async with sessions() as db:
        item = PrintQueueItem(
            printer_id=1,
            status=status,
            dispatch_subtask_id="123",
            dispatched_at=datetime.now(timezone.utc) - timedelta(minutes=10),
            **kwargs,
        )
        db.add(item)
        await db.commit()
        return item.id


async def add_linked_job(sessions, identity, status="printing", with_archive=True):
    async with sessions() as db:
        item = PrintQueueItem(printer_id=1, status=status, dispatch_subtask_id=identity)
        db.add(item)
        await db.flush()
        if with_archive:
            archive = PrintArchive(
                printer_id=1,
                dispatched_queue_item_id=item.id,
                filename="same.3mf",
                file_path="",
                file_size=0,
                status="printing",
                subtask_id=identity,
            )
            db.add(archive)
            await db.flush()
            item.archive_id = archive.id
        await db.commit()
        return item.id, item.archive_id


@pytest.mark.parametrize("status", ["dispatching", "printing"])
@pytest.mark.parametrize("stop_outcome", ["sent", "offline", "error"])
@pytest.mark.parametrize("with_archive", [True, False])
async def test_stop_unmatched_run_keeps_plate_gate_before_release_and_after_restart(
    sessions, status, stop_outcome, with_archive
):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    item_id, archive_id = await add_linked_job(sessions, "old-session", status, with_archive)
    manager = PrinterManager()
    live = SimpleNamespace(state="RUNNING", connected=True, submission_id="new-session", subtask_id="0")
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(intake, "printer_manager", manager),
        patch.object(print_effects, "printer_manager", manager),
        patch("backend.app.services.printer_manager.printer_manager", manager),
        patch("backend.app.services.lifecycle.dispatching.printer_manager", manager),
        patch.object(manager, "get_status", return_value=live),
        patch.object(manager, "is_connected", return_value=True),
        patch.object(
            manager,
            "stop_print",
            return_value=stop_outcome == "sent",
            side_effect=RuntimeError("disconnected") if stop_outcome == "error" else None,
        ),
    ):
        async with sessions() as db:
            commit = db.commit

            async def commit_with_plate_gate():
                # Cancellation keeps a database hold; cache effects wait for commit.
                assert (await db.get(PrintQueueItem, item_id)).status == "cancelled"
                await commit()

            with patch.object(db, "commit", commit_with_plate_gate):
                await stop_queue_item(item_id, db, (None, True))

        live.state = "IDLE"
        assert not PrintScheduler().selection._is_printer_idle(1, require_plate_clear=True)
        # The reconnect identity cannot match the old job. Its rejected
        # completion must not be needed to protect the physical plate.
        assert await main.on_print_complete(1, {"submission_id": "new-session", "status": "aborted"}) is False
        async with sessions() as db:
            item = await db.get(PrintQueueItem, item_id)
            assert item.status == "cancelled"
            assert manager.is_awaiting_plate_clear(1)
            assert manager.get_awaiting_plate_clear_archive_id(1) == archive_id
            if archive_id:
                assert (await db.get(PrintArchive, archive_id)).status == "aborted"

        restarted = PrinterManager()
        with patch("backend.app.core.database.async_session", sessions):
            await restarted.load_awaiting_plate_clear_from_db()
        assert restarted.is_awaiting_plate_clear(1)
        assert restarted.get_awaiting_plate_clear_archive_id(1) == archive_id


@pytest.mark.parametrize("active_state", ["PREPARE", "SLICING", "RUNNING", "PAUSE", None])
@pytest.mark.parametrize("missing_id", ["0", 0, "", None])
def test_mqtt_explicit_id_loss_starts_a_separate_observation(active_state, missing_id):
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    starts, finishes = [], []
    client.on_print_running_observed = starts.append
    client.on_print_start = starts.append
    client.on_print_complete = finishes.append
    client._process_message({"print": {"gcode_state": "RUNNING", "subtask_id": "123", "gcode_file": "same.3mf"}})
    # The inactive/terminal push between two prints can be missed. Reusing
    # the filename must not make this unidentifiable run inherit the old ID.
    update = {"subtask_id": missing_id}
    if active_state:
        update["gcode_state"] = active_state
    client._process_message({"print": update})
    assert len(starts) == 2
    identity = starts[1]["submission_id"]
    assert identity and identity != "123"
    assert "previous_submission_id" not in starts[1]
    client._process_message({"print": {"gcode_state": "RUNNING", "subtask_id": "0"}})
    assert len(starts) == 2
    client._process_message({"print": {"gcode_state": "FINISH", "subtask_id": "0"}})
    assert finishes[0]["submission_id"] == identity


@pytest.mark.parametrize("terminal_state", ["FINISH", "FAILED", "IDLE"])
def test_mqtt_omitted_active_id_and_terminal_zero_preserve_the_observed_run(terminal_state):
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    starts, finishes = [], []
    client.on_print_running_observed = starts.append
    client.on_print_start = starts.append
    client.on_print_complete = finishes.append
    client._process_message({"print": {"gcode_state": "RUNNING", "subtask_id": "123", "gcode_file": "same.3mf"}})
    client._process_message({"print": {"gcode_state": "PAUSE"}})
    client._process_message({"print": {"gcode_state": "RUNNING"}})
    client._process_message({"print": {"gcode_state": terminal_state, "subtask_id": "0"}})
    assert len(starts) == 1
    assert finishes[0]["submission_id"] == "123"


async def test_mqtt_id_loss_cannot_complete_or_recover_the_previous_job(sessions):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.bambu_mqtt import BambuMQTTClient
    from backend.app.services.lifecycle import intake

    item_id, archive_id = await add_linked_job(sessions, "123")
    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    client.state.connected = True
    starts, finishes = [], []
    client.on_print_running_observed = starts.append
    client.on_print_start = starts.append
    client.on_print_complete = finishes.append
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(print_effects, "_archive_print_start", AsyncMock()),
        patch.object(intake, "printer_manager", MagicMock()) as manager,
        patch.object(print_effects, "printer_manager", manager),
        patch("backend.app.services.lifecycle.dispatching.printer_manager", manager),
        patch.object(print_effects, "ws_manager", AsyncMock()) as websocket,
    ):
        manager.get_status.return_value = client.state
        client._process_message({"print": {"gcode_state": "RUNNING", "subtask_id": "123", "gcode_file": "same.3mf"}})
        await main.on_print_start(1, starts[-1])
        client._process_message({"print": {"gcode_state": "RUNNING", "subtask_id": "0", "gcode_file": "other.3mf"}})
        await main.on_print_start(1, starts[-1])
        client._process_message({"print": {"gcode_state": "FINISH", "subtask_id": "0"}})
        assert await main.on_print_complete(1, finishes[-1]) is False
        async with sessions() as db:
            await PrintScheduler().dispatcher.recover(db)
        manager.set_awaiting_plate_clear.assert_not_called()
        websocket.send_print_complete.assert_not_awaited()
    async with sessions() as db:
        item = await db.get(PrintQueueItem, item_id)
        archive = await db.get(PrintArchive, archive_id)
        assert item.status == "printing"
        assert item.dispatch_subtask_id == "123"
        assert archive.status == "printing"
        assert archive.subtask_id == "123"
        assert len((await db.scalars(select(PrintQueueItem))).all()) == 1


@pytest.mark.parametrize("value", [None, "", "0", 0])
async def test_missing_ids_never_match_a_job(sessions, value):
    await add_job(sessions, "printing")
    async with sessions() as db:
        identity = event_identity({"filename": "same.3mf", "subtask_id": value})
        assert await find_job(db, 1, identity) is None
        assert await observe_print(db, 1, identity) == (None, False)


async def test_external_start_is_one_job_and_cannot_take_a_dispatch(sessions):
    async with sessions() as db:
        first, confirmed = await observe_print(db, 1, "external")
        await db.commit()
        again, confirmed = await observe_print(db, 1, "external")
        assert again.id == first.id
        assert first.status == "printing"
        assert first.created_by_id is None
        assert await observe_print(db, 1, "different") == (None, False)
        await transition_queue_item(db, first, "printing", "finished")
        from backend.app.services.lifecycle.awaiting import clear_job_plate

        await clear_job_plate(db, first)
        await db.commit()
        following, confirmed = await observe_print(db, 1, "next")
        await db.commit()
        assert following.id != first.id
        assert len((await db.scalars(select(PrintQueueItem))).all()) == 2


async def test_start_requires_exact_dispatch_id_and_uses_transition(sessions):
    item_id = await add_job(sessions)
    async with sessions() as db:
        assert await observe_print(db, 1, "old") == (None, False)
        assert (await db.get(PrintQueueItem, item_id)).status == "dispatching"
        item, confirmed = await observe_print(db, 1, "123")
        await db.commit()
        assert confirmed is True
        assert item.id == item_id
        assert item.status == "printing"
        assert item.started_at is not None


@pytest.mark.parametrize(
    "state, identity, connected, expected",
    [
        ("FINISH", "123", True, "finished"),
        ("FAILED", "123", True, "failed"),
        ("FINISH", "other", True, "printing"),
        ("FINISH", None, True, "printing"),
        ("IDLE", "123", True, "printing"),
        ("FINISH", "123", False, "printing"),
        ("PAUSE", "123", True, "paused"),
    ],
)
async def test_startup_checks_already_printing_jobs_by_id(sessions, state, identity, connected, expected):
    item_id = await add_job(sessions, "printing")
    scheduler = PrintScheduler()
    status = SimpleNamespace(state=state, subtask_id=identity, connected=connected)
    spawned = []

    def capture(coro, **kwargs):
        spawned.append(coro)
        coro.close()

    with (
        patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", return_value=status),
        patch("backend.app.services.lifecycle.dispatching.spawn_background_task", capture),
    ):
        async with sessions() as db:
            await scheduler.dispatcher.recover(db)
        async with sessions() as db:
            assert (await db.get(PrintQueueItem, item_id)).status == expected
    assert bool(spawned) == (expected in ("finished", "failed"))


@pytest.mark.parametrize("outcome", ["printing", "failed"])
async def test_user_resolution_commits_and_keeps_failed_plate_gate(sessions, outcome):
    item_id = await add_job(sessions)
    manager = MagicMock()
    manager.get_status.return_value = None
    with (
        patch("backend.app.services.printer_manager.printer_manager", manager),
        patch("backend.app.services.lifecycle.effects.publish_queue_job_started", AsyncMock()) as publish,
    ):
        async with sessions() as db:
            await resolve_queue_dispatch(item_id, DispatchResolution(outcome=outcome), db, (None, True))
        async with sessions() as db:
            item = await db.get(PrintQueueItem, item_id)
            assert item.status == outcome
            manager.set_awaiting_plate_clear.assert_called_with(1, outcome == "failed")
            with pytest.raises(HTTPException) as conflict:
                await resolve_queue_dispatch(item_id, DispatchResolution(outcome=outcome), db, (None, True))
            assert conflict.value.status_code == 409
        assert publish.await_count == (outcome == "printing")


@pytest.mark.parametrize("seconds, expected", [(0, False), (269, False), (271, True)])
def test_dispatch_confirmation_prompt_requires_a_finished_send_attempt(seconds, expected):
    item = PrintQueueItem(
        status="dispatching",
        dispatch_subtask_id="123",
        dispatched_at=datetime.now(timezone.utc) - timedelta(seconds=seconds),
    )
    assert needs_dispatch_resolution(item) is expected


async def test_resolution_rejects_other_owner_and_conflicting_live_job(sessions):
    item_id = await add_job(sessions)
    async with sessions() as db:
        with pytest.raises(HTTPException) as forbidden:
            await resolve_queue_dispatch(
                item_id, DispatchResolution(outcome="printing"), db, (SimpleNamespace(id=99), False)
            )
        assert forbidden.value.status_code == 403
        await db.rollback()
        with patch(
            "backend.app.services.printer_manager.printer_manager.get_status",
            return_value=SimpleNamespace(state="RUNNING", subtask_id="different", connected=True),
        ):
            with pytest.raises(HTTPException) as conflict:
                await resolve_queue_dispatch(item_id, DispatchResolution(outcome="failed"), db, (None, True))
            assert conflict.value.status_code == 409
        assert (await db.get(PrintQueueItem, item_id)).status == "dispatching"


@pytest.mark.parametrize("identity", ["wrong", None, "0"])
async def test_wrong_or_missing_completion_id_has_no_side_effects(sessions, identity):
    from backend.app.main import on_print_complete

    item_id = await add_job(sessions, "printing")
    with (
        patch("backend.app.services.lifecycle.intake.async_session", sessions),
        patch("backend.app.services.print_effects.async_session", sessions),
        patch("backend.app.services.lifecycle.intake.printer_manager", MagicMock()) as manager,
        patch("backend.app.services.print_effects.printer_manager", manager),
        patch("backend.app.services.print_effects.ws_manager", AsyncMock()) as websocket,
    ):
        assert (
            await on_print_complete(1, {"subtask_id": identity, "status": "completed", "filename": "same.3mf"}) is False
        )
        manager.set_awaiting_plate_clear.assert_not_called()
        websocket.send_print_complete.assert_not_awaited()
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, item_id)).status == "printing"


async def test_external_observation_survives_callbacks_and_restart(sessions):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    intake._started_job_effects.clear()
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(print_effects, "_archive_print_start", AsyncMock()) as archive,
        patch.object(print_effects, "_begin_new_print", AsyncMock()) as begin,
        patch.object(print_effects, "_finish_new_print", AsyncMock()) as finish,
    ):
        await main.on_print_start(1, {"submission_id": "external", "filename": "same.3mf"})
        await main.on_print_start(1, {"submission_id": "external", "filename": "renamed.3mf"})
        assert archive.await_count == 2
        begin.assert_awaited_once()
        finish.assert_awaited_once()
        intake._started_job_effects.clear()  # Simulate a new application process.
        await main.on_print_start(1, {"submission_id": "external", "filename": "same.3mf"})
    async with sessions() as db:
        items = list((await db.scalars(select(PrintQueueItem))).all())
        assert len(items) == 1
        assert items[0].dispatch_subtask_id == "external"


async def test_failed_archive_start_is_retried_for_the_same_job(sessions):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    archive = AsyncMock(side_effect=[RuntimeError("start WebSocket failed"), True])
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(print_effects, "_archive_print_start", archive),
        patch.object(print_effects, "_begin_new_print", AsyncMock()) as begin,
        patch.object(print_effects, "_finish_new_print", AsyncMock()) as finish,
    ):
        event = {"submission_id": "external", "filename": "same.3mf"}
        with pytest.raises(RuntimeError, match="start WebSocket failed"):
            await main.on_print_start(1, event)
        assert intake._started_job_effects.get(1) is not None
        await main.on_print_start(1, event)
        begin.assert_awaited_once()
        finish.assert_awaited_once()
    assert archive.await_count == 2
    async with sessions() as db:
        job = await find_job(db, 1, "external")
        assert intake._started_job_effects[1] == job.id


async def test_running_recovery_observes_job_without_new_start_effects(sessions):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    job_id, archive_id = await add_linked_job(sessions, "existing")
    archive_start = AsyncMock()
    live = SimpleNamespace(state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="existing")
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(print_effects, "_archive_print_start", archive_start),
        patch.object(print_effects, "_restore_usage_tracking_session", AsyncMock()),
        patch.object(print_effects, "_capture_timelapse_baseline_at_start", AsyncMock()),
        patch.object(main.printer_manager, "get_status", return_value=live),
    ):
        await main.on_print_running_observed(
            1, {"submission_id": "existing", "filename": "same.3mf", "raw_data": {"gcode_state": "RUNNING"}}
        )
    assert archive_start.await_count == 1
    assert archive_start.await_args.kwargs == {
        "queue_archive_id": archive_id,
        "queue_job_id": job_id,
        "memory": intake.print_memory,
    }
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, job_id)).status == "printing"


@pytest.mark.parametrize("previous_status", ["finished", "failed", "cancelled"])
async def test_touchscreen_print_takes_over_the_hold_without_releasing_the_printer(sessions, previous_status):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    old_id, archive_id = await add_linked_job(sessions, "previous", previous_status)
    previous_outcome = {"finished": "completed", "failed": "failed", "cancelled": "aborted"}[previous_status]
    async with sessions() as db:
        (await db.get(PrintArchive, archive_id)).status = previous_outcome
        await db.commit()
    manager = PrinterManager()
    live = SimpleNamespace(
        connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="touchscreen", subtask_id="0"
    )
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(intake, "printer_manager", manager),
        patch.object(print_effects, "printer_manager", manager),
        patch("backend.app.services.printer_manager.printer_manager", manager),
        patch.object(manager, "get_status", return_value=live),
        patch.object(print_effects, "_archive_print_start", AsyncMock()) as archive_print,
        patch.object(print_effects, "_begin_new_print", AsyncMock()) as begin,
        patch.object(print_effects, "_finish_new_print", AsyncMock()) as finish,
    ):
        await main.on_print_start(1, {"submission_id": "touchscreen", "filename": "same.3mf"})
        await main.on_print_start(1, {"submission_id": "touchscreen", "filename": "same.3mf"})
        assert archive_print.await_count == 2
        begin.assert_awaited_once()
        finish.assert_awaited_once()
        async with sessions() as db:
            new = await find_job(db, 1, "touchscreen")
            assert new is not None and new.id != old_id and new.status == "printing"
            held = list(await db.scalars(select(PrintQueueItem).where(PrintQueueItem.status.in_(HOLDING_STATUSES))))
            assert [item.id for item in held] == [new.id]
            assert (await db.get(PrintArchive, archive_id)).status == previous_outcome
            with pytest.raises(HTTPException) as conflict:
                await clear_queue_plate(old_id, db, None)
            assert conflict.value.status_code == 409
            await db.rollback()
        intake._started_job_effects.clear()  # Simulate restart while the touchscreen print is running.
        await main.on_print_start(1, {"submission_id": "touchscreen", "filename": "same.3mf"})
        async with sessions() as db:
            new = await find_job(db, 1, "touchscreen")
            live.state = "FINISH"
            await transition_queue_item(db, new, "printing", "finished")
            await db.commit()
            assert manager.is_awaiting_plate_clear(1)
            await clear_queue_plate(new.id, db, None)
            assert new.status == "successful"
            assert not list(await db.scalars(select(PrintQueueItem).where(PrintQueueItem.status.in_(HOLDING_STATUSES))))


@pytest.mark.parametrize(
    "connected, ready, identity", [(False, True, "new"), (True, False, "new"), (True, True, "later")]
)
async def test_delayed_or_disconnected_start_cannot_replace_a_plate_hold(sessions, connected, ready, identity):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    old_id = await add_job(sessions, "finished")
    state = SimpleNamespace(connected=connected, job_telemetry_ready=ready, state="RUNNING", submission_id=identity)
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(main.printer_manager, "get_status", return_value=state),
        patch.object(print_effects, "_archive_print_start", AsyncMock()) as archive,
    ):
        await main.on_print_start(1, {"submission_id": "new", "filename": "same.3mf"})
        archive.assert_not_awaited()
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, old_id)).status == "finished"
        assert len(list(await db.scalars(select(PrintQueueItem)))) == 1


async def test_rolling_back_external_hold_transfer_restores_the_previous_job(sessions):
    old_id = await add_job(sessions, "failed")
    manager = PrinterManager()
    with patch("backend.app.services.printer_manager.printer_manager", manager):
        with patch("backend.app.core.database.async_session", sessions):
            await manager.load_awaiting_plate_clear_from_db()
        assert manager.is_awaiting_plate_clear(1)
        async with sessions() as db:
            live = SimpleNamespace(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="new")
            new, _ = await observe_print(db, 1, "new", observed_state=live)
            assert new is not None
            assert manager.is_awaiting_plate_clear(1)
            await db.rollback()
        assert manager.is_awaiting_plate_clear(1)
        async with sessions() as db:
            assert (await db.get(PrintQueueItem, old_id)).status == "failed"
            assert len(list(await db.scalars(select(PrintQueueItem)))) == 1


@pytest.mark.parametrize("terminal", ["FINISH", "FAILED", "IDLE"])
async def test_short_external_start_still_transfers_the_hold_before_its_terminal_callback(sessions, terminal):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    await add_job(sessions, "failed")
    live = SimpleNamespace(connected=True, job_telemetry_ready=True, state=terminal, submission_id="short-print")
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(main.printer_manager, "get_status", return_value=live),
        patch.object(print_effects, "_archive_print_start", AsyncMock()),
    ):
        await main.on_print_start(1, {"submission_id": "short-print", "raw_data": {"gcode_state": "RUNNING"}})
    async with sessions() as db:
        assert (await find_job(db, 1, "short-print")).status == "printing"


async def test_old_duplicate_identity_cannot_take_the_hold_from_another_ended_job(sessions):
    async with sessions() as db:
        db.add(PrintQueueItem(printer_id=1, status="successful", dispatch_subtask_id="old"))
        current = PrintQueueItem(printer_id=1, status="failed", dispatch_subtask_id="current")
        db.add(current)
        await db.commit()
        live = SimpleNamespace(connected=True, job_telemetry_ready=True, state="RUNNING", submission_id="old")
        assert await observe_print(db, 1, "old", observed_state=live) == (None, False)
        assert current.status == "failed"


@pytest.mark.parametrize("live_state", ["RUNNING", "FINISH", "FAILED"])
async def test_delayed_cancelled_completion_cannot_run_effects_for_a_later_job(sessions, live_state):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    await add_job(sessions, "cancelled")
    with (
        patch.object(intake, "async_session", sessions),
        patch.object(intake, "printer_manager", MagicMock()) as manager,
    ):
        manager.get_status.return_value = SimpleNamespace(state=live_state, connected=True, subtask_id="later-job")
        assert await main.on_print_complete(1, {"subtask_id": "123", "status": "failed"}) is False
        manager.set_awaiting_plate_clear.assert_not_called()


async def test_partial_start_waits_for_file_metadata_before_archiving(sessions):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(print_effects, "_archive_print_start", AsyncMock()) as archive,
    ):
        await main.on_print_start(1, {"submission_id": "external"})
        archive.assert_not_awaited()
        await main.on_print_start(1, {"submission_id": "external", "filename": "same.3mf"})
        archive.assert_awaited_once()
    async with sessions() as db:
        assert len((await db.scalars(select(PrintQueueItem))).all()) == 1


def test_explicit_missing_snapshot_does_not_use_stale_raw_id():
    assert event_identity({"submission_id": None, "raw_data": {"subtask_id": "stale"}}) is None
    assert event_identity({"submission_id": "external", "raw_data": {"subtask_id": "0"}}) == "external"


@pytest.mark.parametrize("state", ["PREPARE", "SLICING", "RUNNING", "PAUSE"])
def test_mqtt_external_local_id_survives_partial_and_terminal_updates(state):
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    starts, finishes = [], []
    client.on_print_running_observed = starts.append
    client.on_print_complete = finishes.append
    client._process_message({"print": {"gcode_state": state, "subtask_id": "0", "gcode_file": "same.3mf"}})
    identity = starts[0]["submission_id"]
    assert identity and identity != "0"
    client._process_message({"print": {"gcode_state": "RUNNING", "gcode_file": "renamed.3mf"}})
    client._process_message({"print": {"gcode_state": "FINISH", "subtask_id": "0"}})
    assert finishes[0]["submission_id"] == identity
    assert len(starts) == 1


def test_mqtt_start_snapshot_uses_observed_id_never_last_command():
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    starts = []
    client.on_print_running_observed = starts.append
    client._process_message({"print": {"subtask_id": "123", "gcode_state": "PREPARE"}})
    client._process_message({"print": {"gcode_state": "RUNNING"}})
    assert starts[0]["submission_id"] == "123"


@pytest.mark.parametrize("later_state", ["RUNNING", "FINISH"])
def test_mqtt_late_firmware_id_carries_exact_prior_session_identity(later_state):
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="127.0.0.1", serial_number="TEST", access_code="12345678")
    events = []
    client.on_print_running_observed = events.append
    client.on_print_start = events.append
    client.on_print_complete = events.append
    client._process_message({"print": {"gcode_state": "PREPARE", "subtask_id": "0"}})
    local_id = events[0]["submission_id"]
    client._process_message({"print": {"gcode_state": later_state, "subtask_id": "123"}})
    assert events[-1]["submission_id"] == "123"
    assert events[-1]["previous_submission_id"] == local_id
    client._process_message({"print": {"gcode_state": "IDLE"}})
    client._process_message({"print": {"gcode_state": "PREPARE"}})
    assert events[-1]["submission_id"] not in (local_id, "123", None)


async def test_duplicate_start_after_stop_does_not_create_an_external_job(sessions):
    item_id = await add_job(sessions, "cancelled")
    async with sessions() as db:
        assert await observe_print(db, 1, "123") == (None, False)
        assert len(list((await db.scalars(select(PrintQueueItem))).all())) == 1
        assert (await db.get(PrintQueueItem, item_id)).status == "cancelled"


async def test_external_archive_is_linked_by_identity_not_name(sessions):
    import backend.app.main as main
    from backend.app.models.archive import PrintArchive
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    intake._started_job_effects.clear()

    async def archive_worker(printer_id, data, **kwargs):
        async with sessions() as db:
            db.add_all(
                [
                    PrintArchive(
                        printer_id=printer_id,
                        filename="same.3mf",
                        file_path="",
                        file_size=0,
                        status="printing",
                        subtask_id="wrong",
                    ),
                    PrintArchive(
                        printer_id=printer_id,
                        filename="same.3mf",
                        file_path="",
                        file_size=0,
                        status="printing",
                        subtask_id=data["submission_id"],
                    ),
                ]
            )
            await db.commit()
        return True

    with (
        patch.object(intake, "async_session", sessions),
        patch.object(print_effects, "async_session", sessions),
        patch.object(print_effects, "_archive_print_start", archive_worker),
    ):
        await main.on_print_start(1, {"submission_id": "external", "filename": "same.3mf"})
    async with sessions() as db:
        item = await find_job(db, 1, "external")
        archive = await db.get(PrintArchive, item.archive_id)
        assert archive.subtask_id == "external"
        assert archive.dispatched_queue_item_id == item.id
        await bind_observed_id(db, 1, "firmware", "external")
        await db.commit()
        assert item.dispatch_subtask_id == "firmware"
        assert archive.subtask_id == "firmware"
        assert await find_job(db, 1, "external") is None
        assert (await find_job(db, 1, "firmware")).id == item.id


async def test_debug_completion_uses_identified_active_attempt(sessions, monkeypatch):
    import backend.app.main as main
    from backend.app.api.routes.printers import debug_simulate_print_complete
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    complete = AsyncMock()
    monkeypatch.setattr(intake, "print_completed", complete)
    _, archive_id = await add_linked_job(sessions, "current")
    async with sessions() as db:
        ended = PrintQueueItem(printer_id=1, status="unsuccessful", dispatch_subtask_id="ended")
        db.add(ended)
        await db.flush()
        db.add(
            PrintArchive(
                printer_id=1,
                filename="stale.3mf",
                file_path="",
                file_size=0,
                status="printing",
                subtask_id="ended",
                dispatched_queue_item_id=ended.id,
            )
        )
        db.add(
            PrintArchive(
                printer_id=1, filename="old.3mf", file_path="", file_size=0, status="completed", subtask_id="old"
            )
        )
        db.add(
            PrintArchive(
                printer_id=1, filename="unowned.3mf", file_path="", file_size=0, status="printing", subtask_id="other"
            )
        )
        await db.commit()
        result = await debug_simulate_print_complete(1, db=db, _=None)
        assert result["archive_id"] == archive_id
        assert complete.await_args.args[1]["submission_id"] == "current"
        (await db.get(PrintArchive, archive_id)).status = "completed"
        await db.commit()
        with pytest.raises(HTTPException) as error:
            await debug_simulate_print_complete(1, db=db, _=None)
        assert error.value.status_code == 404
        complete.assert_awaited_once()
