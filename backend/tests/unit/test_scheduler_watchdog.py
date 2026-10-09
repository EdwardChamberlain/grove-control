"""Regression tests for durable queue dispatch acknowledgement."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.lifecycle import effects as lifecycle_effects
from backend.app.services.lifecycle.engine import transition_queue_item
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.queue_archive import link_dispatch_archive, prepare_dispatch_archive


@pytest.fixture
async def db_session(tmp_path, monkeypatch):
    """In-memory SQLite with one queue item assigned to printer 42."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import backend.app.models  # noqa: F401 - populate Base.metadata
    from backend.app.core.config import settings
    from backend.app.core.database import Base, _migrate_queue_lifecycle
    from backend.app.models.archive import PrintArchive
    from backend.app.models.printer import Printer

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    source = tmp_path / "source.3mf"
    source.write_bytes(b"dispatch source")

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate_queue_lifecycle(conn)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        db.add(Printer(id=42, name="Test", serial_number="TEST", ip_address="127.0.0.1", access_code="code"))
        db.add(PrintArchive(id=99, filename="source.3mf", file_path=str(source), file_size=15, status="completed"))
        db.add(PrintQueueItem(id=1, printer_id=42, archive_id=99, status="queued"))
        await db.commit()

    try:
        yield session_maker
    finally:
        await engine.dispose()


async def hold_and_link(db, item):
    await transition_queue_item(db, item, item.status, "dispatching")
    await db.commit()
    prepared = await prepare_dispatch_archive(db, item)
    await link_dispatch_archive(db, item, prepared)


def _status(state: str, subtask_id: str | None = None, gcode_file: str | None = None):
    return SimpleNamespace(connected=True, state=state, subtask_id=subtask_id, gcode_file=gcode_file)


class TestDurableDispatchingState:
    @pytest.mark.asyncio
    async def test_confirmation_promotes_only_after_active_telemetry(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

        scheduler = PrintScheduler()
        publish = AsyncMock()
        with (
            patch.object(
                scheduler.dispatcher,
                "_wait_for_ack",
                new=AsyncMock(return_value=("printing", _status("PREPARE", "12345"))),
            ),
            patch("backend.app.services.lifecycle.dispatching.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
            patch.object(lifecycle_effects, "publish_queue_job_started", new=publish),
        ):
            await scheduler.dispatcher._confirm(
                item_id=1,
                printer_id=42,
                subtask_id="12345",
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            assert item.status == "printing"
            assert item.started_at is not None
        publish.assert_awaited_once_with(1)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("telemetry_status", "last_status", "expect_reconnect"),
        [
            (None, _status("IDLE", "OLD_SUBTASK"), True),
            ("dispatching", _status("IDLE", "12345"), False),
        ],
    )
    async def test_unconfirmed_dispatch_is_held_without_retry(
        self,
        db_session,
        telemetry_status,
        last_status,
        expect_reconnect,
    ):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        scheduler = PrintScheduler()
        client = MagicMock()
        with (
            patch.object(
                scheduler.dispatcher,
                "_wait_for_ack",
                new=AsyncMock(return_value=(telemetry_status, last_status)),
            ),
            patch("backend.app.services.lifecycle.dispatching.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
            patch("backend.app.services.lifecycle.dispatching.printer_manager.get_client", return_value=client),
        ):
            await scheduler.dispatcher._confirm(
                item_id=1,
                printer_id=42,
                subtask_id="12345",
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.dispatched_at is not None
            assert item.started_at is None
            assert item.error_message and "held for manual review" in item.error_message
        if expect_reconnect:
            client.force_reconnect_stale_session.assert_called_once()
        else:
            client.force_reconnect_stale_session.assert_not_called()

    @pytest.mark.asyncio
    async def test_unacknowledged_dispatch_keeps_its_durable_attempt(self, db_session):
        from backend.app.models.archive import PrintArchive

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        scheduler = PrintScheduler()
        with (
            patch.object(
                scheduler.dispatcher,
                "_wait_for_ack",
                new=AsyncMock(return_value=(None, _status("IDLE", "OLD_SUBTASK"))),
            ),
            patch("backend.app.services.lifecycle.dispatching.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
            patch("backend.app.services.lifecycle.dispatching.printer_manager.get_client", return_value=None),
        ):
            await scheduler.dispatcher._confirm(
                item_id=1,
                printer_id=42,
                subtask_id="12345",
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            archive = await db.get(PrintArchive, item.archive_id)
            assert item.status == "dispatching"
            assert archive.dispatched_queue_item_id == item.id
            assert archive.subtask_id == item.dispatch_subtask_id

    @pytest.mark.asyncio
    async def test_correlated_terminal_dispatch_is_not_retried(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

        scheduler = PrintScheduler()
        with (
            patch.object(
                scheduler.dispatcher,
                "_wait_for_ack",
                new=AsyncMock(return_value=("failed", _status("FAILED", "12345"))),
            ),
            patch("backend.app.services.lifecycle.dispatching.async_session", db_session),
            patch("backend.app.core.database.async_session", db_session),
        ):
            await scheduler.dispatcher._confirm(
                item_id=1,
                printer_id=42,
                subtask_id="12345",
            )

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.error_message is None

    @pytest.mark.asyncio
    async def test_restart_recovery_publishes_the_normal_start_event(self, db_session):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            scheduler = PrintScheduler()
            publish = AsyncMock()
            tasks: list[asyncio.Task] = []

            def spawn(coro, **_kwargs):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

            with (
                patch(
                    "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                    return_value=_status("RUNNING", "12345"),
                ),
                patch("backend.app.services.lifecycle.dispatching.spawn_background_task", side_effect=spawn),
                patch.object(lifecycle_effects, "publish_queue_job_started", new=publish),
            ):
                await scheduler.dispatcher.recover(db)
                await asyncio.gather(*tasks)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "printing"
            assert item.started_at is not None
        publish.assert_awaited_once_with(1)

    @pytest.mark.asyncio
    async def test_restart_recovery_publishes_no_start_when_its_commit_fails(self, db_session):
        """A recovered start is published only once the promotion has committed."""
        from sqlalchemy import event
        from sqlalchemy.exc import OperationalError

        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            scheduler = PrintScheduler()
            publish, spawn = AsyncMock(), MagicMock()

            def fail_commit(_connection):
                raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

            engine = db.bind.sync_engine
            event.listen(engine, "commit", fail_commit)
            try:
                with (
                    patch(
                        "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                        return_value=_status("RUNNING", "12345"),
                    ),
                    patch("backend.app.services.lifecycle.dispatching.spawn_background_task", spawn),
                    patch.object(lifecycle_effects, "publish_queue_job_started", new=publish),
                    pytest.raises(OperationalError),
                ):
                    await scheduler.dispatcher.recover(db)
            finally:
                event.remove(engine, "commit", fail_commit)
            await db.rollback()

        spawn.assert_not_called()
        publish.assert_not_called()
        async with db_session() as db:
            assert (await db.get(PrintQueueItem, 1)).status == "dispatching"

    @pytest.mark.asyncio
    async def test_restart_recovery_does_not_promote_an_active_print_with_another_submission_id(self, db_session):
        """An unrelated manual print must not acknowledge a durable dispatch."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            with patch(
                "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                return_value=_status("RUNNING", "other-job"),
            ):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.started_at is None

    @pytest.mark.asyncio
    async def test_restart_recovery_does_not_treat_missing_ids_as_a_match(self, db_session):
        """Legacy rows without an id must not accept an uncorrelated active print."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc)
            item.dispatch_subtask_id = None
            await db.commit()

            with patch(
                "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                return_value=_status("RUNNING"),
            ):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.started_at is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("archive_linked", [False, True])
    async def test_restart_fails_a_held_dispatch_before_any_command_id(self, db_session, archive_linked):
        """A dead worker cannot leave an unsent hold waiting for manual review."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            if archive_linked:
                await hold_and_link(db, item)
            else:
                await transition_queue_item(db, item, "queued", "dispatching")
            item.dispatching_at = None  # Startup clears the dead worker's claim.
            await db.commit()
            attempt_id = item.archive_id

            with (
                patch(
                    "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                    return_value=_status("RUNNING", "unrelated-job"),
                ),
                patch("backend.app.services.printer_manager.printer_manager.start_print") as start,
                patch("backend.app.services.lifecycle.dispatching.async_session", db_session),
                patch("backend.app.services.lifecycle.effects.run_queue_outcome_effects", new=AsyncMock()),
            ):
                await PrintScheduler().dispatcher.start()

            await db.refresh(item)
            assert item.status == "failed"
            assert item.error_message == "Dispatch interrupted before print command; retry required"
            assert item.dispatch_subtask_id is None
            start.assert_not_called()
            from backend.app.models.archive import PrintArchive

            attempt = await db.get(PrintArchive, attempt_id)
            await db.refresh(attempt)
            assert attempt.status == ("failed" if archive_linked else "completed")

    @pytest.mark.asyncio
    @pytest.mark.parametrize("printer_subtask_id", ["other-job", None])
    async def test_restart_recovery_holds_stale_active_dispatch_without_matching_id(
        self, db_session, printer_subtask_id
    ):
        """An uncorrelated active printer is unsafe to requeue automatically."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            with patch(
                "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                return_value=_status("RUNNING", printer_subtask_id),
            ):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.completed_at is None
            assert item.error_message and "held for manual review" in item.error_message

    @pytest.mark.asyncio
    @pytest.mark.parametrize("printer_status", [_status("IDLE"), None])
    async def test_restart_recovery_holds_stale_uncertain_dispatch(self, db_session, printer_status):
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            with patch(
                "backend.app.services.lifecycle.dispatching.printer_manager.get_status",
                return_value=printer_status,
            ):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.dispatched_at is not None
            assert item.error_message and "held for manual review" in item.error_message

    @pytest.mark.asyncio
    async def test_restart_recovery_holds_terminal_dispatch_without_matching_id(self, db_session):
        """Unknown terminal telemetry must not cause a duplicate retry."""
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            # This is the shape the MQTT parser exposes when a terminal push
            # carries subtask_id=0 after a restart.
            status = _status("FINISH", "0", "completed-while-down.3mf")
            status.raw_data = {"subtask_id": "0"}
            with patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", return_value=status):
                await PrintScheduler().dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.completed_at is None
            assert item.dispatch_subtask_id == "12345"
            assert item.error_message and "held for manual review" in item.error_message

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("printer_state", "expected_status"),
        [("FINISH", "finished"), ("FAILED", "failed")],
    )
    async def test_restart_recovery_completes_matching_terminal_dispatch_instead_of_requeueing(
        self, db_session, printer_state, expected_status
    ):
        """A job that finished while the service was down must not retry.

        BambuMQTT correctly ignores an arbitrary first terminal update after a
        reconnect. The queue's durable submission id makes this one safe to
        attribute, so recovery passes it through the normal completion handler.
        """
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=300)
            item.dispatch_subtask_id = "12345"
            await db.commit()

            complete = AsyncMock()
            status = _status(printer_state, "12345", "completed-while-down.3mf")
            status.raw_data = {"subtask_id": "12345"}
            tasks: list[asyncio.Task] = []

            def spawn(coro, **_kwargs):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

            with (
                patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", return_value=status),
                patch("backend.app.services.lifecycle.intake.print_completed", new=complete),
                patch("backend.app.services.lifecycle.dispatching.spawn_background_task", side_effect=spawn),
            ):
                await PrintScheduler().dispatcher.recover(db)
                await asyncio.gather(*tasks)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == expected_status
            assert item.completed_at is not None
            complete.assert_awaited_once_with(
                42,
                {
                    "status": "completed" if expected_status == "finished" else expected_status,
                    "filename": "completed-while-down.3mf",
                    "subtask_name": "",
                    "subtask_id": "12345",
                    "raw_data": {"subtask_id": "12345"},
                    "_reconciled": True,
                    "_recovered_dispatch": True,
                },
            )

    @pytest.mark.asyncio
    async def test_current_process_dispatch_is_not_recovered_from_previous_terminal_state(self, db_session):
        """Fresh dispatches must wait for their confirmation task.

        A partial MQTT update can replace the printer's subtask_id while the
        cached gcode_state is still FINISH/FAILED for the previous job. The
        restart-recovery path must not interpret that mixed-generation state as
        completion of a dispatch created by this scheduler process.
        """
        dispatched_at = datetime.now(timezone.utc)
        async with db_session() as db:
            item = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, item)
            item.dispatched_at = dispatched_at
            item.dispatch_subtask_id = "NEW_SUBTASK"
            await db.commit()

            scheduler = PrintScheduler()
            scheduler.dispatcher._started_at = dispatched_at - timedelta(seconds=1)
            status = _status("FINISH", "NEW_SUBTASK", "old-job.gcode.3mf")
            with patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", return_value=status):
                await scheduler.dispatcher.recover(db)

            item = await db.get(PrintQueueItem, 1)
            assert item.status == "dispatching"
            assert item.completed_at is None


class TestDispatchConfirmationScheduling:
    @pytest.mark.asyncio
    async def test_slow_confirmation_does_not_block_second_printer_dispatch(self):
        scheduler = PrintScheduler()
        confirmation_started = asyncio.Event()
        release_confirmation = asyncio.Event()
        tasks: list[asyncio.Task] = []
        first = SimpleNamespace(
            id=1,
            printer_id=42,
            archive_id=99,
            library_file_id=None,
            archive=None,
            library_file=None,
            printer=None,
            scheduled_time=None,
            manual_start=False,
            force_color_match=None,
            ams_mapping="[]",
            filament_overrides=None,
            waiting_reason=None,
            print_time_seconds=None,
            position=0,
            been_jumped=False,
        )
        second = SimpleNamespace(**{**first.__dict__, "id": 2, "printer_id": 43})

        pending_result = MagicMock()
        pending_result.scalars.return_value.all.return_value = [first, second]
        busy_result = MagicMock()
        busy_result.all.return_value = []
        db = AsyncMock()
        db.execute = AsyncMock(side_effect=[pending_result, busy_result])
        db.get = AsyncMock(side_effect=[first, second])

        async def slow_confirmation(*_args):
            confirmation_started.set()
            await release_confirmation.wait()

        dispatched: list[int] = []

        async def start_print(db, item, *_args):
            dispatched.append(item.printer_id)
            if item.printer_id == 42:
                scheduler.dispatcher._confirm_later(
                    item_id=item.id,
                    printer_id=item.printer_id,
                    subtask_id="12345",
                )

        def spawn(coro, **_kwargs):
            task = asyncio.create_task(coro)
            tasks.append(task)
            return task

        with (
            patch.object(scheduler.dispatcher, "_confirm", new=slow_confirmation),
            patch("backend.app.services.lifecycle.dispatching.spawn_background_task", side_effect=spawn),
            patch("backend.app.services.lifecycle.queued.spawn_background_task", side_effect=spawn),
            patch("backend.app.services.print_scheduler.async_session") as session_factory,
            patch("backend.app.services.lifecycle.queued.async_session", session_factory),
            patch.object(scheduler.dispatcher, "recover", new=AsyncMock()),
            patch.object(scheduler, "_shutdown_printers", new=AsyncMock(return_value=set())),
            patch.object(scheduler, "_get_bool_setting", new=AsyncMock(return_value=False)),
            patch.object(scheduler.mapping, "_get_bool_setting", new=AsyncMock(return_value=False)),
            patch.object(scheduler.drying, "_get_bool_setting", new=AsyncMock(return_value=False)),
            patch.object(scheduler, "_get_int_setting", new=AsyncMock(return_value=2)),
            patch.object(scheduler.selection, "_is_printer_idle", return_value=True),
            patch.object(scheduler.drying, "_is_printer_idle", return_value=True),
            patch("backend.app.services.lifecycle.dispatching.printer_manager.is_connected", return_value=True),
            patch.object(scheduler.mapping, "_ams_mapping_uses_compatible_materials", return_value=True),
            patch.object(scheduler.selection, "_block_on_filament_deficit", new=AsyncMock(return_value=False)),
            patch("backend.app.services.lifecycle.queued._claim", new=AsyncMock(return_value=True)),
            patch("backend.app.services.lifecycle.queued.release_claim", new=AsyncMock()),
            patch.object(scheduler.workers, "leave", new=start_print),
        ):
            session_factory.return_value.__aenter__ = AsyncMock(return_value=db)
            session_factory.return_value.__aexit__ = AsyncMock(return_value=False)
            await scheduler.check_queue()
            await confirmation_started.wait()
            assert dispatched == [42, 43]
            assert any(not task.done() for task in tasks)

        release_confirmation.set()
        await asyncio.gather(*tasks)


class TestActivePrinterReservation:
    @pytest.mark.asyncio
    async def test_database_allows_only_one_active_queue_item_per_printer(self, db_session):
        async with db_session() as db:
            first = await db.get(PrintQueueItem, 1)
            await hold_and_link(db, first)
            await db.commit()

            db.add(PrintQueueItem(id=2, printer_id=42, archive_id=100, status="dispatching"))
            with pytest.raises(IntegrityError):
                await db.commit()
            await db.rollback()

    @pytest.mark.asyncio
    async def test_terminal_telemetry_does_not_confirm_dispatch(self):
        get_status = MagicMock(return_value=_status("FINISH", "NEW_SUBTASK"))
        with patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", get_status):
            telemetry_status, _ = await PrintScheduler().dispatcher._wait_for_ack(
                printer_id=42,
                subtask_id="NEW_SUBTASK",
                timeout=0.05,
                phase_b_timeout=0.05,
                poll_interval=0.01,
            )

        assert telemetry_status == "dispatching"

    @pytest.mark.asyncio
    async def test_terminal_telemetry_waits_for_active_confirmation(self):
        """A stale terminal state must not end confirmation before RUNNING."""
        get_status = MagicMock(
            side_effect=[
                _status("FINISH", "NEW_SUBTASK"),
                _status("RUNNING", "NEW_SUBTASK"),
            ]
        )
        with patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", get_status):
            telemetry_status, status = await PrintScheduler().dispatcher._wait_for_ack(
                printer_id=42,
                subtask_id="NEW_SUBTASK",
                timeout=0.05,
                phase_b_timeout=0.05,
                poll_interval=0.01,
            )

        assert telemetry_status == "printing"
        assert status.state == "RUNNING"
        assert get_status.call_count == 2

    @pytest.mark.asyncio
    async def test_active_telemetry_requires_this_dispatch_submission_id(self):
        get_status = MagicMock(return_value=_status("RUNNING", "other-job"))
        with patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", get_status):
            telemetry_status, _ = await PrintScheduler().dispatcher._wait_for_ack(
                printer_id=42,
                subtask_id="12345",
                timeout=0.05,
                phase_b_timeout=0.05,
                poll_interval=0.01,
            )

        assert telemetry_status is None

    @pytest.mark.asyncio
    async def test_matching_active_telemetry_confirms_this_dispatch(self):
        get_status = MagicMock(return_value=_status("PREPARE", "12345"))
        with patch("backend.app.services.lifecycle.dispatching.printer_manager.get_status", get_status):
            telemetry_status, _ = await PrintScheduler().dispatcher._wait_for_ack(
                printer_id=42,
                subtask_id="12345",
                timeout=0.05,
                poll_interval=0.01,
            )

        assert telemetry_status == "printing"
