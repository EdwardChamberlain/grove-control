"""PrintJob/archive projection tests for printer assignment at print start."""

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_job_lifecycle import admit_job


@pytest.mark.asyncio
async def test_archive_is_a_reusable_projection_of_the_durable_job(db_session):
    archive = PrintArchive(
        filename="model.3mf",
        file_path="archives/model.3mf",
        file_size=1,
        print_name="model",
        status="archived",
        printer_id=None,
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add(
        Printer(
            id=7,
            name="Printer 7",
            serial_number="TEST-7",
            ip_address="127.0.0.1",
            access_code="12345678",
            model="H2D",
        )
    )
    await db_session.flush()

    job = PrintQueueItem(archive_id=archive.id, printer_id=None, status="pending")
    db_session.add(job)
    await admit_job(db_session, job)
    await db_session.commit()

    # The dispatch/print-start projection may assign the concrete printer;
    # identity remains the job UUID and the archive can be reused by retries.
    job.printer_id = 7
    archive.printer_id = 7
    await db_session.commit()

    loaded = await db_session.scalar(select(PrintQueueItem).where(PrintQueueItem.job_id == job.job_id))
    assert loaded is not None
    assert loaded.archive_id == archive.id
    assert loaded.job_id != str(archive.id)
