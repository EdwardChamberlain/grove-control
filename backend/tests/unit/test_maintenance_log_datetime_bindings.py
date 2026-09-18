"""Maintenance log timestamps must be naive UTC at database boundaries."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend.app.api.routes.maintenance import (
    _decode_log_cursor,
    _encode_log_cursor,
    create_maintenance_log,
    update_maintenance_log,
)
from backend.app.models.maintenance import MaintenanceLogEntry
from backend.app.schemas.maintenance import MaintenanceLogEntryCreate, MaintenanceLogEntryUpdate


class _Result:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value

    def one_or_none(self):
        return self.value


class _CreateSession:
    def __init__(self, printer):
        self.printer = printer
        self.added = []

    async def execute(self, _query):
        return _Result(self.printer)

    def add(self, value):
        self.added.append(value)

    async def commit(self):
        pass

    async def refresh(self, entry):
        entry.id = 1
        entry.created_at = datetime(2026, 1, 1, 0, 0)
        entry.updated_at = entry.created_at


class _UpdateSession:
    def __init__(self, entry):
        self.entry = entry

    async def execute(self, _query):
        return _Result((self.entry, "Maintenance printer"))

    async def commit(self):
        pass

    async def refresh(self, _entry):
        pass


@pytest.mark.asyncio
async def test_manual_create_binds_naive_utc_timestamp():
    printer = SimpleNamespace(id=7, name="Maintenance printer")
    session = _CreateSession(printer)
    occurred_at = datetime(2026, 1, 2, 3, 4, tzinfo=timezone(timedelta(hours=2)))

    response = await create_maintenance_log(
        MaintenanceLogEntryCreate(printer_id=7, title="Repaired", occurred_at=occurred_at),
        session,
        None,
    )

    assert session.added[0].occurred_at == datetime(2026, 1, 2, 1, 4)
    assert session.added[0].occurred_at.tzinfo is None
    assert response.occurred_at.tzinfo is None


@pytest.mark.asyncio
async def test_manual_update_binds_naive_utc_timestamp():
    entry = SimpleNamespace(
        id=1,
        printer_id=7,
        entry_type="manual",
        title="Repair",
        notes=None,
        occurred_at=datetime(2026, 1, 1, 0, 0),
        hours_at_maintenance=None,
        created_by_id=None,
        created_by_username=None,
        updated_by_id=None,
        updated_by_username=None,
        created_at=datetime(2026, 1, 1, 0, 0),
        updated_at=datetime(2026, 1, 1, 0, 0),
    )
    session = _UpdateSession(entry)
    occurred_at = datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc)

    response = await update_maintenance_log(
        1,
        MaintenanceLogEntryUpdate(occurred_at=occurred_at),
        session,
        None,
    )

    assert entry.occurred_at == datetime(2026, 1, 2, 3, 4)
    assert entry.occurred_at.tzinfo is None
    assert response.occurred_at.tzinfo is None


def test_log_cursor_decodes_to_naive_utc_timestamp():
    entry = MaintenanceLogEntry()
    entry.id = 9
    entry.occurred_at = datetime(2026, 1, 2, 3, 4)

    cursor_time, cursor_id = _decode_log_cursor(_encode_log_cursor(entry))

    assert cursor_time == entry.occurred_at
    assert cursor_time.tzinfo is None
    assert cursor_id == 9
