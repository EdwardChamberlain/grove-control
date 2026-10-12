"""Live action labels use the legacy queue model, independent of job ownership."""

from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant


async def test_shared_queue_work_tracks_waiting_and_terminal_jobs(async_client, printer_factory, db_session):
    printer = await printer_factory(model="X1C")
    job = PrintQueueItem(printer_id=printer.id, status="pending")
    db_session.add(job)
    await db_session.commit()
    response = await async_client.get("/api/v1/printers/queue-work")
    assert response.status_code == 200
    assert response.json()[str(printer.id)] is True
    job.status = "completed"
    await db_session.commit()
    response = await async_client.get("/api/v1/printers/queue-work")
    assert response.json()[str(printer.id)] is False


async def test_shared_queue_work_matches_pool_location_and_variant_models(async_client, printer_factory, db_session):
    first = await printer_factory(model="X1C", location="Workshop")
    second = await printer_factory(model="P1S", location="Workshop")
    elsewhere = await printer_factory(model="P1S", location="Office")
    source = LibraryFile(filename="slice.3mf", file_path="slice.3mf", file_type="3mf", file_size=1)
    db_session.add(source)
    await db_session.flush()
    job = PrintQueueItem(status="pending", target_model="x1c", target_location="Workshop")
    job.variants.append(PrintQueueVariant(target_model="p1s", library_file_id=source.id))
    db_session.add(job)
    await db_session.commit()
    response = await async_client.get("/api/v1/printers/queue-work")
    assert response.status_code == 200
    assert response.json() == {str(first.id): True, str(second.id): True, str(elsewhere.id): False}
