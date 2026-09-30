"""Stage 2: real job matching, external observations, recovery and user resolution."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.api.routes.print_queue import resolve_queue_dispatch
from backend.app.core.database import Base, _ensure_active_queue_printer_reservation
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.schemas.print_queue import DispatchResolution
from backend.app.services.job_identity import bind_observed_id, event_identity, find_job, observe_print
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.queue_transitions import transition_queue_item


@pytest.fixture
async def sessions(tmp_path):
    import backend.app.main as main

    main._completed_job_events.clear()
    main._observed_job_starts.clear()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'jobs.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_active_queue_printer_reservation(conn)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(Printer(id=1, name="Printer", serial_number="TEST", ip_address="127.0.0.1", access_code="12345678"))
        await db.commit()
    yield maker
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
        await transition_queue_item(db, first, "printing", "completed")
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
        ("FINISH", "123", True, "completed"),
        ("FAILED", "123", True, "failed"),
        ("FINISH", "other", True, "printing"),
        ("FINISH", None, True, "printing"),
        ("IDLE", "123", True, "printing"),
        ("FINISH", "123", False, "printing"),
        ("PAUSE", "123", True, "printing"),
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
        patch("backend.app.services.print_scheduler.printer_manager.get_status", return_value=status),
        patch("backend.app.services.print_scheduler.spawn_background_task", capture),
    ):
        async with sessions() as db:
            await scheduler._recover_stale_dispatches(db)
        async with sessions() as db:
            assert (await db.get(PrintQueueItem, item_id)).status == expected
    assert bool(spawned) == (expected in ("completed", "failed"))


@pytest.mark.parametrize("outcome", ["printing", "failed"])
async def test_user_resolution_commits_and_keeps_failed_plate_gate(sessions, outcome):
    item_id = await add_job(sessions)
    manager = MagicMock()
    manager.get_status.return_value = None
    with (
        patch("backend.app.services.printer_manager.printer_manager", manager),
        patch("backend.app.services.print_scheduler.scheduler._publish_queue_job_started", AsyncMock()) as publish,
    ):
        async with sessions() as db:
            await resolve_queue_dispatch(item_id, DispatchResolution(outcome=outcome), db, (None, True))
        async with sessions() as db:
            item = await db.get(PrintQueueItem, item_id)
            assert item.status == outcome
            assert (await db.get(Printer, 1)).awaiting_plate_clear == (outcome == "failed")
            with pytest.raises(HTTPException) as conflict:
                await resolve_queue_dispatch(item_id, DispatchResolution(outcome=outcome), db, (None, True))
            assert conflict.value.status_code == 409
        assert publish.await_count == (outcome == "printing")


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
        patch("backend.app.main.async_session", sessions),
        patch("backend.app.main.printer_manager", MagicMock()) as manager,
        patch("backend.app.main.ws_manager", AsyncMock()) as websocket,
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

    main._observed_job_starts.clear()
    with (
        patch.object(main, "async_session", sessions),
        patch.object(main, "_archive_print_start", AsyncMock()) as archive,
    ):
        await main.on_print_start(1, {"submission_id": "external", "filename": "same.3mf"})
        await main.on_print_start(1, {"submission_id": "external", "filename": "renamed.3mf"})
        archive.assert_awaited_once()
        main._observed_job_starts.clear()  # Simulate a new application process.
        await main.on_print_start(1, {"submission_id": "external", "filename": "same.3mf"})
    async with sessions() as db:
        items = list((await db.scalars(select(PrintQueueItem))).all())
        assert len(items) == 1
        assert items[0].dispatch_subtask_id == "external"


@pytest.mark.parametrize("live_state", ["RUNNING", "FINISH", "FAILED"])
async def test_delayed_cancelled_completion_cannot_run_effects_for_a_later_job(sessions, live_state):
    import backend.app.main as main

    await add_job(sessions, "cancelled")
    with patch.object(main, "async_session", sessions), patch.object(main, "printer_manager", MagicMock()) as manager:
        manager.get_status.return_value = SimpleNamespace(state=live_state, connected=True, subtask_id="later-job")
        assert await main.on_print_complete(1, {"subtask_id": "123", "status": "failed"}) is False
        manager.set_awaiting_plate_clear.assert_not_called()


async def test_partial_start_waits_for_file_metadata_before_archiving(sessions):
    import backend.app.main as main

    with (
        patch.object(main, "async_session", sessions),
        patch.object(main, "_archive_print_start", AsyncMock()) as archive,
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
    client.last_dispatch_subtask_id = "stale-command"
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

    main._observed_job_starts.clear()

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

    with patch.object(main, "async_session", sessions), patch.object(main, "_archive_print_start", archive_worker):
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
