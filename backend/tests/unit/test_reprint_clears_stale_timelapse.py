"""Run-projection tests for reusable Archive rows under PrintJob retries."""

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_job_lifecycle import (
    COMPLETED,
    DISPATCHING,
    PRINTING,
    admit_job,
    bind_device_task,
    create_retry_job,
    mark_dispatch_attempted,
    transition_job,
)


@pytest.mark.asyncio
async def test_retry_gets_new_job_identity_while_archive_remains_reusable(db_session):
    archive = PrintArchive(
        filename="model.3mf",
        file_path="archives/model.3mf",
        file_size=1,
        print_name="model",
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add(
        Printer(
            id=1,
            name="Printer 1",
            serial_number="TEST-RETRY-1",
            ip_address="127.0.0.1",
            access_code="12345678",
            model="H2D",
        )
    )
    await db_session.flush()
    original = PrintQueueItem(archive_id=archive.id, printer_id=1, status="pending")
    db_session.add(original)
    await admit_job(db_session, original)
    await transition_job(db_session, original, to_state=DISPATCHING, source="test")
    await mark_dispatch_attempted(db_session, original, source="test")
    await bind_device_task(
        db_session,
        item=original,
        device_subtask_id="task-1",
        connection_epoch="epoch-1",
        event_sequence=1,
    )
    await transition_job(db_session, original, to_state=PRINTING, source="test")
    await transition_job(
        db_session,
        original,
        to_state=COMPLETED,
        source="test",
        physical_execution_observed=True,
    )
    retry = await create_retry_job(db_session, original, source="user_retry")
    await db_session.commit()

    assert retry.job_id != original.job_id
    assert retry.previous_job_id == original.job_id
    assert retry.archive_id == archive.id
    assert original.queue_visible is False
    assert retry.queue_visible is True
    assert len((await db_session.scalars(select(PrintQueueItem))).all()) == 2
