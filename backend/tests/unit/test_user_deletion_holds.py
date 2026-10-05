"""User deletion must not act as an implicit Clear Plate, including FK cascades."""

import pytest
from fastapi import HTTPException
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.api.routes.print_queue import clear_queue_plate
from backend.app.api.routes.users import delete_user
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.services.lifecycle.engine import HOLDING_STATUSES


@pytest.fixture(params=[False, True], ids=["sqlite-default", "foreign-keys"])
async def sessions(tmp_path, request):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'users.db'}")
    if request.param:

        @event.listens_for(engine.sync_engine, "connect")
        def enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add_all(
            [
                User(id=1, username="owner", password_hash="unused"),
                Printer(id=1, name="Printer", serial_number="TEST", ip_address="127.0.0.1", access_code="code"),
            ]
        )
        await db.commit()
    yield maker
    await engine.dispose()


async def add_held_job(sessions, status, reference):
    async with sessions() as db:
        archive = PrintArchive(
            printer_id=1,
            filename="source.3mf",
            file_path="",
            file_size=0,
            created_by_id=1 if reference == "archive" else None,
        )
        library = LibraryFile(
            filename="source.3mf",
            file_path="",
            file_size=0,
            file_type="3mf",
            created_by_id=1 if reference == "library" else None,
        )
        db.add_all([archive, library])
        await db.flush()
        item = PrintQueueItem(
            printer_id=1,
            status=status,
            archive_id=archive.id,
            library_file_id=library.id,
            created_by_id=1 if reference == "job" else None,
        )
        db.add(item)
        await db.commit()
        return item.id, archive.id, library.id


@pytest.mark.parametrize("status", HOLDING_STATUSES)
@pytest.mark.parametrize("reference", ["job", "archive", "library"])
async def test_deleting_user_items_refuses_every_affected_hold(sessions, status, reference):
    item_id, archive_id, library_id = await add_held_job(sessions, status, reference)
    async with sessions() as db:
        with pytest.raises(HTTPException) as conflict:
            await delete_user(1, delete_items=True, _admin=None, current_user=None, db=db)
        assert conflict.value.status_code == 409
        await db.rollback()
    async with sessions() as db:
        assert await db.get(User, 1) is not None
        assert (await db.get(PrintQueueItem, item_id)).status == status
        assert await db.get(PrintArchive, archive_id) is not None
        assert await db.get(LibraryFile, library_id) is not None


@pytest.mark.parametrize("status", ["finished", "failed", "cancelled"])
async def test_deleting_account_keeps_an_actionable_ownerless_hold(sessions, status):
    item_id, _, _ = await add_held_job(sessions, status, "job")
    async with sessions() as db:
        await delete_user(1, delete_items=False, _admin=None, current_user=None, db=db)
    async with sessions() as db:
        assert await db.get(User, 1) is None
        item = await db.get(PrintQueueItem, item_id)
        assert item.status == status and item.created_by_id is None
        await clear_queue_plate(item_id, db, None)
        assert item.status == ("successful" if status == "finished" else "unsuccessful")


async def test_deleting_user_items_succeeds_after_explicit_plate_clear(sessions):
    item_id, _, _ = await add_held_job(sessions, "failed", "job")
    async with sessions() as db:
        await clear_queue_plate(item_id, db, None)
        await delete_user(1, delete_items=True, _admin=None, current_user=None, db=db)
    async with sessions() as db:
        assert await db.get(User, 1) is None
        assert await db.get(PrintQueueItem, item_id) is None
        assert not list(await db.scalars(select(PrintQueueItem)))
