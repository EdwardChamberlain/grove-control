"""Connected-edge reconciliation preserves active work and uses exact job identity."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _state(state: str, *, subtask_id: str = "", subtask_name: str = "", connected: bool = True) -> SimpleNamespace:
    """Minimal PrinterState stub for the pure decision function."""
    return SimpleNamespace(
        state=state,
        subtask_id=subtask_id,
        subtask_name=subtask_name,
        connected=connected,
        raw_data={},
    )


def _archive(
    subtask_id: str | None = "ABC123", filename: str = "ghost.3mf", print_name: str = "ghost"
) -> SimpleNamespace:
    """Minimal PrintArchive stub — only the fields the decision function reads."""
    return SimpleNamespace(
        id=42,
        dispatched_queue_item_id=None,
        subtask_id=subtask_id,
        filename=filename,
        print_name=print_name,
    )


def _status_state(state: str, *, connected: bool = True) -> SimpleNamespace:
    """Minimal status-change payload for the reconciliation edge tests."""
    return SimpleNamespace(
        connected=connected,
        state=state,
        progress=0,
        layer_num=0,
        temperatures={},
        raw_data={},
        stg_cur=0,
        cooling_fan_speed=0,
        big_fan1_speed=0,
        big_fan2_speed=0,
        chamber_light="",
        active_extruder=0,
        tray_now=0,
        door_open=False,
        ams_filament_backup=None,
        remaining_time=0,
        gcode_file=None,
        subtask_name="",
        hms_errors=[],
    )


class TestReconcileStaleActivePrints:
    """Orchestrator-level tests — mock the printer manager + DB session so
    we can drive the decision flow end-to-end without standing up real
    fixtures.

    These cover:
      * No printer status (disconnected) → no-op, no on_print_complete fired.
      * No active archives → no-op.
      * Stale archive → synthesised on_print_complete called with status
        ``"aborted"`` and the `_reconciled: True` marker so downstream code
        can distinguish synthetic from real completions.
      * Non-stale archive → on_print_complete NOT called (no false positive
        on a healthy in-flight print).
      * Exception inside on_print_complete must NOT block reconciliation
        for subsequent archives or crash the caller.
    """

    @pytest.mark.asyncio
    async def test_connected_active_state_defers_until_next_reconnect(self):
        """An active reconnect must not race its later completion callback."""
        from backend.app import main as main_module
        from backend.app.main import on_printer_status_change
        from backend.app.services.lifecycle import intake

        scheduled = []

        def capture_task(coro, *, name):
            scheduled.append(name)
            coro.close()

        with (
            patch("backend.app.main.spawn_background_task", side_effect=capture_task),
            patch("backend.app.services.lifecycle.intake.spawn_background_task", side_effect=capture_task),
            patch("backend.app.main.mqtt_relay") as mock_relay,
            patch("backend.app.main.printer_state_to_dict", return_value={}),
            patch.dict(intake._printer_reconciled_since_connect, {}, clear=True),
            patch.object(intake, "_pending_stale_reconciliation", set()),
            patch.dict(main_module._last_status_broadcast, {}, clear=True),
        ):
            mock_relay.on_printer_status = AsyncMock()
            await on_printer_status_change(1, _status_state("RUNNING"))
            assert scheduled == []
            assert intake._pending_stale_reconciliation == {1}

            await on_printer_status_change(1, _status_state("IDLE"))
            assert scheduled == []

            # The real completion callback calls this after its terminal work
            # has finished, making the deferred reconciliation safe to run.
            intake._schedule_pending_stale_reconciliation(1)

        assert scheduled == ["reconcile-stale-prints-after-completion-1"]

    @pytest.mark.asyncio
    async def test_terminal_reconnect_flushes_pending_reconciliation(self):
        from backend.app import main as main_module
        from backend.app.main import on_printer_status_change
        from backend.app.services.lifecycle import intake

        scheduled = []

        def capture_task(coro, *, name):
            scheduled.append(name)
            coro.close()

        with (
            patch("backend.app.main.spawn_background_task", side_effect=capture_task),
            patch("backend.app.services.lifecycle.intake.spawn_background_task", side_effect=capture_task),
            patch("backend.app.main.mqtt_relay") as mock_relay,
            patch("backend.app.main.printer_state_to_dict", return_value={}),
            patch.dict(intake._printer_reconciled_since_connect, {}, clear=True),
            patch.object(intake, "_pending_stale_reconciliation", set()),
            patch.dict(main_module._last_status_broadcast, {}, clear=True),
        ):
            mock_relay.on_printer_status = AsyncMock()
            await on_printer_status_change(1, _status_state("RUNNING"))
            await on_printer_status_change(1, _status_state("IDLE", connected=False))
            await on_printer_status_change(1, _status_state("IDLE"))

        assert scheduled == ["reconcile-stale-prints-after-completion-1"]

    @pytest.mark.asyncio
    async def test_no_status_skips_reconciliation(self):
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = None
            count = await reconcile_stale_active_prints(printer_id=1)
        assert count == 0

    @pytest.mark.asyncio
    async def test_disconnected_status_skips_reconciliation(self):
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state("RUNNING", connected=False)
            count = await reconcile_stale_active_prints(printer_id=1)
        # Disconnected state would be making decisions against cached state —
        # the connected-edge handler in on_printer_status_change is the only
        # place that should drive reconciliation.
        assert count == 0

    @pytest.mark.asyncio
    async def test_no_active_archives_returns_zero(self):
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state("IDLE")
            with patch("backend.app.services.lifecycle.intake.async_session") as mock_session:
                session_ctx = AsyncMock()
                session_ctx.execute = AsyncMock(return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: [])))
                mock_session.return_value.__aenter__.return_value = session_ctx
                count = await reconcile_stale_active_prints(printer_id=1)
        assert count == 0

    @pytest.mark.asyncio
    async def test_exact_terminal_identity_synthesises_completion(self):
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        stale = _archive(subtask_id="OLD_ID", filename="ghost.3mf", print_name="ghost")
        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state("FINISH", subtask_id="OLD_ID", subtask_name="")
            with patch("backend.app.services.lifecycle.intake.async_session") as mock_session:
                session_ctx = AsyncMock()
                session_ctx.execute = AsyncMock(return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: [stale])))
                mock_session.return_value.__aenter__.return_value = session_ctx
                with patch("backend.app.services.lifecycle.intake.print_completed", new=AsyncMock()) as mock_complete:
                    count = await reconcile_stale_active_prints(printer_id=1)
        assert count == 1
        mock_complete.assert_awaited_once()
        # Verify the synthesised payload shape.
        args, kwargs = mock_complete.call_args
        assert args[0] == 1
        payload = args[1]
        assert payload["status"] == "completed"
        assert payload["filename"] == "ghost.3mf"
        assert payload["_reconciled"] is True

    @pytest.mark.asyncio
    async def test_status_is_rechecked_after_archive_query(self):
        """A connected-edge IDLE snapshot must not complete a print that has
        started while reconciliation was waiting on the archive query."""
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        active = _archive(subtask_id="ABC123", filename="job.3mf", print_name="job")
        idle = _state("IDLE")
        running = _state("RUNNING", subtask_id="ABC123", subtask_name="job")
        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.side_effect = [idle, running]
            with patch("backend.app.services.lifecycle.intake.async_session") as mock_session:
                session_ctx = AsyncMock()
                session_ctx.execute = AsyncMock(return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: [active])))
                mock_session.return_value.__aenter__.return_value = session_ctx
                with patch("backend.app.services.lifecycle.intake.print_completed", new=AsyncMock()) as mock_complete:
                    count = await reconcile_stale_active_prints(printer_id=1)

        assert count == 0
        mock_complete.assert_not_called()

    @pytest.mark.asyncio
    async def test_non_stale_archive_does_not_synthesise(self):
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        healthy = _archive(subtask_id="ABC123")
        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state("RUNNING", subtask_id="ABC123", subtask_name="ghost")
            with patch("backend.app.services.lifecycle.intake.async_session") as mock_session:
                session_ctx = AsyncMock()
                session_ctx.execute = AsyncMock(
                    return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: [healthy]))
                )
                mock_session.return_value.__aenter__.return_value = session_ctx
                with patch("backend.app.services.lifecycle.intake.print_completed", new=AsyncMock()) as mock_complete:
                    count = await reconcile_stale_active_prints(printer_id=1)
        assert count == 0
        mock_complete.assert_not_called()

    @pytest.mark.asyncio
    async def test_reconciliation_ignores_unmatched_archives_and_handles_failure(self):
        """An exception during one archive's synthesis must not abort
        reconciliation for the other archives — and must not propagate to
        the caller (the connected-edge handler is a hot path)."""
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        a1 = _archive(subtask_id="A", filename="a.3mf")
        a1.id = 1
        a2 = _archive(subtask_id="B", filename="b.3mf")
        a2.id = 2
        a3 = _archive(subtask_id="C", filename="c.3mf")
        a3.id = 3
        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state("FINISH", subtask_id="B")
            with patch("backend.app.services.lifecycle.intake.async_session") as mock_session:
                session_ctx = AsyncMock()
                session_ctx.execute = AsyncMock(
                    return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: [a1, a2, a3]))
                )
                mock_session.return_value.__aenter__.return_value = session_ctx
                # First call raises, second is suppressed, and the third succeeds.
                mock_complete = AsyncMock(side_effect=[RuntimeError("boom"), False, None])
                with patch("backend.app.services.lifecycle.intake.print_completed", new=mock_complete):
                    count = await reconcile_stale_active_prints(printer_id=1)
        # Only the third archive is recorded as reconciled: the first raised
        # and the second explicitly reported that it was suppressed.
        assert count == 0
        assert mock_complete.await_count == 1

    @pytest.mark.asyncio
    async def test_reconciled_completion_is_ignored_while_printing(self):
        """The final live-state check must suppress every synthetic side effect,
        even when the printer has not populated a subtask name yet."""
        from backend.app.main import on_print_complete

        with (
            patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm,
            patch("backend.app.services.print_effects.clear_3mf_cache") as mock_clear_cache,
            patch("backend.app.services.print_effects.ws_manager") as mock_ws,
        ):
            mock_pm.get_status.return_value = _state(
                "RUNNING",
                subtask_id="",
                subtask_name="",
            )
            mock_pm.get_status.return_value.gcode_file = "/data/Metadata/job.gcode.3mf"
            mock_pm.get_status.return_value.current_print = "/data/Metadata/job.gcode.3mf"
            mock_ws.send_print_complete = AsyncMock()

            result = await on_print_complete(
                1,
                {
                    "status": "aborted",
                    "filename": "job.gcode.3mf",
                    "subtask_name": "job",
                    "subtask_id": "OLD_ID",
                    "raw_data": {"subtask_id": "NEW_ID"},
                    "_reconciled": True,
                },
            )

        assert result is False
        mock_clear_cache.assert_not_called()
        mock_ws.send_print_complete.assert_not_awaited()
        mock_pm.set_awaiting_plate_clear.assert_not_called()

    @pytest.mark.asyncio
    async def test_active_print_defers_different_stale_archive(self):
        """A different stale archive must wait for a terminal printer state.

        Calling the full completion handler while another print is active
        would raise plate-clear and publish a false completion for the live
        printer, so reconciliation must defer the archive instead.
        """
        from backend.app.services.lifecycle.intake import reconcile_stale_active_prints

        stale = _archive(subtask_id="OLD_ID", filename="old.gcode.3mf", print_name="old")
        running = _state("RUNNING", subtask_id="NEW_ID", subtask_name="new")
        running.gcode_file = "/data/Metadata/new.gcode.3mf"
        running.current_print = "/data/Metadata/new.gcode.3mf"
        with patch("backend.app.services.lifecycle.intake.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = running
            with patch("backend.app.services.lifecycle.intake.async_session") as mock_session:
                session_ctx = AsyncMock()
                session_ctx.execute = AsyncMock(return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: [stale])))
                mock_session.return_value.__aenter__.return_value = session_ctx
                with patch("backend.app.services.lifecycle.intake.print_completed", new=AsyncMock()) as mock_complete:
                    count = await reconcile_stale_active_prints(printer_id=1)

        assert count == 0
        mock_complete.assert_not_awaited()
