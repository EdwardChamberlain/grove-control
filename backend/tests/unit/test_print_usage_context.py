"""Persisted print usage context survives late association and restart."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.lifecycle.engine import transition_queue_item
from backend.tests.unit.test_queue_archive_alignment import alignment, hold_and_link  # noqa: F401


@pytest.mark.parametrize("recovering", [False, True])
@pytest.mark.parametrize("mapping", ["[2, -1]", "invalid legacy mapping"])
async def test_start_context_comes_from_identified_job_without_filename_registration(
    alignment, monkeypatch, recovering, mapping
):
    import backend.app.main as main
    from backend.app.services import print_effects
    from backend.app.services.lifecycle import intake

    async with alignment.sessions() as db:
        job = await db.get(PrintQueueItem, alignment.job_id)
        job.ams_mapping = mapping
        job.plate_id = 3
        job.created_by_id = 42
        await hold_and_link(db, job)
        await transition_queue_item(db, job, "dispatching", "printing", values={"dispatch_subtask_id": "123"})
        await db.commit()
        archive_id = job.archive_id
    observed = AsyncMock(return_value=True)
    live = SimpleNamespace(state="RUNNING", connected=True, job_telemetry_ready=True, submission_id="123")
    monkeypatch.setattr(intake, "async_session", alignment.sessions)
    monkeypatch.setattr(print_effects, "async_session", alignment.sessions)
    monkeypatch.setattr(main.printer_manager, "get_status", lambda _id: live)
    monkeypatch.setattr(intake, "_started_job_effects", {})
    monkeypatch.setattr(print_effects, "_archive_print_start", observed)
    await intake._observe_print_start(
        1,
        {"submission_id": "123", "filename": "repeated.3mf", "ams_mapping": [99], "plate_id": 9},
        recovering=recovering,
    )
    data = observed.call_args.args[1]
    assert data["ams_mapping"] == ([2, -1] if mapping == "[2, -1]" else [99])
    assert data["plate_id"] == 3 and data["owner_id"] == 42
    assert observed.call_args.kwargs["queue_job_id"] == alignment.job_id
    assert observed.call_args.kwargs["queue_archive_id"] == archive_id


class TestPersistedPrintUsageContext:
    """Late promotion updates must survive a restart before completion."""

    class _FakeDB:
        def __init__(self, row):
            self.row = row
            self.commits = 0

        async def get(self, _model, _printer_id):
            return self.row

        async def commit(self):
            self.commits += 1

    @pytest.mark.asyncio
    async def test_persists_mapping_and_plate_for_late_promotion(self):
        from types import SimpleNamespace

        from backend.app.services.usage_tracker import update_persisted_session_context

        row = SimpleNamespace(ams_mapping=None, plate_id=None)
        db = self._FakeDB(row)

        changed = await update_persisted_session_context(
            db,
            printer_id=1,
            ams_mapping=[2, -1],
            plate_id=3,
        )

        assert changed is True
        assert row.ams_mapping == [2, -1]
        assert row.plate_id == 3
        assert db.commits == 1

    @pytest.mark.asyncio
    async def test_does_not_overwrite_existing_queue_context(self):
        from types import SimpleNamespace

        from backend.app.services.usage_tracker import update_persisted_session_context

        row = SimpleNamespace(ams_mapping=[5], plate_id=1)
        db = self._FakeDB(row)

        changed = await update_persisted_session_context(
            db,
            printer_id=1,
            ams_mapping=[2, -1],
            plate_id=3,
        )

        assert changed is False
        assert row.ams_mapping == [5]
        assert row.plate_id == 1
        assert db.commits == 0
