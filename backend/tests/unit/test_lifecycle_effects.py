"""Contracts of the lifecycle after-commit and rollback registry (#204)."""

import logging
import sqlite3
from collections import Counter

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.printer import Printer
from backend.app.services.lifecycle import effects


@pytest.fixture
async def database(tmp_path):
    path = tmp_path / "effects.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield path, async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
def sessions(database):
    return database[1]


def printer(serial: str) -> Printer:
    return Printer(name=serial, serial_number=serial, ip_address="127.0.0.1", access_code="code")


async def test_effects_run_in_order_once_the_commit_is_durable(database):
    path, sessions = database
    seen = []

    def committed() -> int:
        # A separate connection sees only committed rows.
        with sqlite3.connect(path) as observer:
            return observer.execute("SELECT count(*) FROM printers").fetchone()[0]

    async with sessions() as db:
        db.add(printer("A"))
        effects.after_commit(db, lambda: seen.append(("first", committed())))
        effects.after_commit(db, lambda: seen.append(("second", committed())))
        await db.flush()
        assert seen == []
        await db.commit()
        assert seen == [("first", 1), ("second", 1)]
        await db.commit()  # A later, empty transaction does not replay them.
    assert seen == [("first", 1), ("second", 1)]


async def test_a_key_replaces_the_earlier_effect_in_its_position(sessions):
    seen = []
    async with sessions() as db:
        effects.after_commit(db, lambda: seen.append("printer 1 printing"), key=("view", 1))
        effects.after_commit(db, lambda: seen.append("log"))
        effects.after_commit(db, lambda: seen.append("log"))  # Unkeyed effects never replace each other.
        effects.after_commit(db, lambda: seen.append("printer 1 finished"), key=("view", 1))
        effects.after_commit(db, lambda: seen.append("printer 2 printing"), key=("view", 2))
        await db.commit()
    assert seen == ["printer 1 finished", "log", "log", "printer 2 printing"]


async def test_rollback_discards_effects_and_runs_undo_steps_once(sessions):
    seen = Counter()
    async with sessions() as db:
        db.add(printer("A"))
        effects.after_commit(db, lambda: seen.update(["effect"]))
        effects.on_rollback(db, lambda: seen.update(["undo"]))
        await db.rollback()
        assert seen == {"undo": 1}

        db.add(printer("B"))
        await db.commit()  # The next transaction carries none of the discarded work.
    assert seen == {"undo": 1}


async def test_work_queued_before_any_statement_belongs_to_that_transaction(sessions):
    seen = Counter()
    async with sessions() as db:
        effects.after_commit(db, lambda: seen.update(["effect"]))
        effects.on_rollback(db, lambda: seen.update(["undo"]))
        await db.rollback()
        assert seen == {"undo": 1}
        await db.commit()
    assert seen == {"undo": 1}


async def test_commit_drops_undo_steps(sessions):
    seen = Counter()
    async with sessions() as db:
        db.add(printer("A"))
        effects.on_rollback(db, lambda: seen.update(["undo"]))
        await db.commit()
        db.add(printer("B"))
        await db.rollback()
    assert seen == {}


async def test_closing_the_session_counts_as_rollback(sessions):
    seen = Counter()
    async with sessions() as db:
        db.add(printer("A"))
        effects.after_commit(db, lambda: seen.update(["effect"]))
        effects.on_rollback(db, lambda: seen.update(["undo"]))
        await db.flush()
    assert seen == {"undo": 1}


async def test_a_failed_commit_runs_no_effects(sessions):
    seen = Counter()
    async with sessions() as db:
        db.add(printer("A"))
        await db.commit()
        db.add(printer("A"))  # Duplicate serial: the commit's flush fails.
        effects.after_commit(db, lambda: seen.update(["effect"]))
        effects.on_rollback(db, lambda: seen.update(["undo"]))
        with pytest.raises(IntegrityError):
            await db.commit()
        assert "effect" not in seen
        await db.rollback()
        assert seen == {"undo": 1}

        db.add(printer("B"))
        await db.commit()
    assert seen == {"undo": 1}


async def test_a_failing_effect_is_logged_without_undoing_the_commit_or_skipping_others(sessions, caplog):
    seen = []

    def fail():
        raise RuntimeError("notification service down")

    async with sessions() as db:
        db.add(printer("A"))
        effects.after_commit(db, fail)
        effects.after_commit(db, lambda: seen.append("later effect"))
        await db.commit()  # Does not raise: the transaction has committed.
    assert seen == ["later effect"]
    assert "Lifecycle effect failed" in caplog.text
    async with sessions() as db:
        assert await db.scalar(select(func.count(Printer.id))) == 1


async def test_a_failing_undo_step_is_logged_without_skipping_others(sessions, caplog):
    seen = []

    def fail():
        raise OSError("directory busy")

    async with sessions() as db:
        effects.on_rollback(db, fail)
        effects.on_rollback(db, lambda: seen.append("later undo"))
        await db.rollback()
    assert seen == ["later undo"]
    assert "Lifecycle undo step failed" in caplog.text


async def test_savepoints_neither_run_nor_discard_the_outer_work(sessions):
    seen = Counter()
    async with sessions() as db:
        effects.after_commit(db, lambda: seen.update(["effect"]))
        effects.on_rollback(db, lambda: seen.update(["undo"]))
        async with db.begin_nested():
            db.add(printer("A"))
        assert seen == {}  # Releasing a savepoint commits nothing yet.
        with pytest.raises(IntegrityError):
            async with db.begin_nested():
                db.add(printer("A"))
                await db.flush()
        assert seen == {}  # Rolling back a savepoint keeps the outer transaction's work.
        await db.commit()
    assert seen == {"effect": 1}


async def test_work_cannot_be_queued_inside_a_savepoint(sessions):
    async with sessions() as db, db.begin_nested():
        with pytest.raises(RuntimeError, match="savepoint"):
            effects.after_commit(db, lambda: None)
        with pytest.raises(RuntimeError, match="savepoint"):
            effects.on_rollback(db, lambda: None)


async def test_effects_belong_to_the_session_that_queued_them(sessions):
    seen = []
    async with sessions() as first, sessions() as second:
        effects.after_commit(first, lambda: seen.append("first"))
        second.add(printer("A"))
        await second.commit()
        assert seen == []
        await first.commit()
    assert seen == ["first"]


@pytest.fixture(autouse=True)
def _errors_only(caplog):
    caplog.set_level(logging.ERROR, logger=effects.logger.name)
