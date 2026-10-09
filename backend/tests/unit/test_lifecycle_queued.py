"""Specify the queued state's entry (#204 stage 4).

Every new job enters queued through ``create_job``, which places it in its
queue: its printer's, or the pool. Jobs join the end, a 1-based position that
later jobs make room for, or the top: ahead of every waiting job that could
take the same printer. ``filament_contract`` derives a job's materials and
overrides from its sliced source, for every creation path.
"""

import ast
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.printer import Printer
from backend.app.services.lifecycle.queued import create_job, filament_contract

APP = Path(__file__).parents[2] / "app"


@pytest.fixture
async def sessions(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'queued.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        for printer_id in (1, 2):
            db.add(
                Printer(
                    id=printer_id,
                    name=f"Printer {printer_id}",
                    serial_number=f"TEST{printer_id}",
                    ip_address="127.0.0.1",
                    access_code="code",
                )
            )
        for file_id in (7, 8):
            db.add(
                LibraryFile(
                    id=file_id, filename=f"{file_id}.3mf", file_path=f"{file_id}.3mf", file_type="3mf", file_size=1
                )
            )
        await db.commit()
    yield maker
    await engine.dispose()


async def existing(sessions, *jobs: dict) -> list[int]:
    async with sessions() as db:
        rows = []
        for job in jobs:
            variants = job.pop("variants", ())
            row = PrintQueueItem(status=job.pop("status", "queued"), **job)
            row.variants.extend(PrintQueueVariant(**variant) for variant in variants)
            rows.append(row)
        db.add_all(rows)
        await db.commit()
        return [row.id for row in rows]


async def positions(sessions) -> dict[int, int]:
    async with sessions() as db:
        return dict((await db.execute(select(PrintQueueItem.id, PrintQueueItem.position))).all())


async def test_jobs_join_the_end_of_their_own_queue(sessions):
    await existing(
        sessions,
        {"assigned_printer_id": 1, "position": 4},
        {"printer_id": 1, "position": 9, "status": "printing"},  # No longer waiting.
        {"assigned_printer_id": 2, "position": 6},
        {"position": 8},
    )
    async with sessions() as db:
        assigned = await create_job(db, [{"printer_id": 1}, {"printer_id": 1}])
        pool = await create_job(db, [{"library_file_id": 7}])
        empty = await create_job(db, [])
        await db.commit()
    assert [job.position for job in assigned] == [5, 6]
    assert [job.position for job in pool] == [9]
    assert empty == []
    assert all(job.status == "queued" for job in (*assigned, *pool))


async def test_jobs_added_at_a_position_make_room_only_in_their_queue(sessions):
    first, second, other, pool = await existing(
        sessions,
        {"assigned_printer_id": 1, "position": 1},
        {"assigned_printer_id": 1, "position": 2},
        {"assigned_printer_id": 2, "position": 1},
        {"position": 1},
    )
    async with sessions() as db:
        added = await create_job(db, [{"printer_id": 1}] * 2, at=2)
        await db.commit()
    assert [job.position for job in added] == [2, 3]
    assert {key: value for key, value in (await positions(sessions)).items() if key <= pool} == {
        first: 1,
        second: 4,
        other: 1,
        pool: 1,
    }


@pytest.mark.parametrize(("at", "expected"), [(99, 3), (0, 1), (-5, 1)])
async def test_a_position_is_kept_within_the_queue(sessions, at, expected):
    await existing(sessions, {"assigned_printer_id": 1, "position": 1}, {"assigned_printer_id": 1, "position": 2})
    async with sessions() as db:
        [job] = await create_job(db, [{"printer_id": 1}], at=at)
    assert job.position == expected


async def test_the_top_of_a_printers_queue_is_ahead_of_every_waiting_job(sessions):
    await existing(sessions, {"assigned_printer_id": 1, "position": -3}, {"assigned_printer_id": 2, "position": -9})
    async with sessions() as db:
        [job] = await create_job(db, [{"printer_id": 1}], at="top")
        [first] = await create_job(db, [{"printer_id": 2}], at="top")
    assert (job.position, first.position) == (-4, -10)


async def test_the_top_of_the_pool_is_ahead_of_the_jobs_that_could_take_the_same_printer(sessions):
    await existing(
        sessions,
        {"target_model": "H2S", "position": -2},
        {"target_model": "H2D", "position": -5, "variants": [{"library_file_id": 8, "target_model": "H2C"}]},
        {"target_model": "X1C", "position": -20},  # Can't take an H2S or H2C printer.
        {"assigned_printer_id": 1, "position": -30},
    )
    async with sessions() as db:
        [h2s] = await create_job(db, [{"target_model": "H2S"}], at="top")
        [either] = await create_job(
            db,
            [{"target_model": "H2S"}],
            at="top",
            variants=[{"library_file_id": 7, "target_model": "H2S"}, {"library_file_id": 8, "target_model": "H2C"}],
        )
    assert h2s.position == -3
    assert either.position == -6


async def test_each_job_gets_its_own_variants_and_the_shortest_estimate(sessions):
    variants = [
        {"library_file_id": 7, "target_model": "H2S", "position": 0, "print_time_seconds": 600},
        {"library_file_id": 8, "target_model": "H2C", "position": 1, "print_time_seconds": 300},
    ]
    async with sessions() as db:
        jobs = await create_job(db, [{"target_model": "H2S", "print_time_seconds": 900}] * 2, variants=variants)
        [plain] = await create_job(db, [{"printer_id": 1, "print_time_seconds": 900}])
        [unknown] = await create_job(
            db, [{"target_model": "H2S"}], variants=[{**variants[0], "print_time_seconds": None}]
        )
        await db.commit()
        rows = (await db.scalars(select(PrintQueueVariant).order_by(PrintQueueVariant.id))).all()
    assert [job.print_time_seconds for job in (*jobs, plain, unknown)] == [300, 300, 900, None]
    assert [(row.queue_item_id, row.library_file_id) for row in rows] == [
        (jobs[0].id, 7),
        (jobs[0].id, 8),
        (jobs[1].id, 7),
        (jobs[1].id, 8),
        (unknown.id, 7),
    ]


async def test_jobs_are_flushed_for_their_ids_and_left_for_the_caller_to_commit(sessions):
    async with sessions() as db:
        [job] = await create_job(db, [{"printer_id": 1}])
        assert job.id is not None
        await db.rollback()
    assert await positions(sessions) == {}


async def test_placement_takes_its_queues_lock_on_postgresql(sessions, monkeypatch):
    locks = []
    async with sessions() as db:
        execute = db.execute

        async def record_lock(statement, params=None, **kwargs):
            if "pg_advisory_xact_lock" in str(statement):
                locks.append(params)
                return None
            return await execute(statement, params, **kwargs)

        monkeypatch.setattr(db, "get_bind", lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql")))
        monkeypatch.setattr(db, "execute", record_lock)
        await create_job(db, [{"printer_id": 2}])
        await create_job(db, [{"target_model": "H2S"}], at="top")
    assert locks == [{"k": 2}, {"k": 0}]


def sliced(path: Path, *filaments: tuple[int, str, str]) -> Path:
    plate = "".join(
        f'<filament id="{slot}" type="{kind}" color="{color}" used_g="5"/>' for slot, kind, color in filaments
    )
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "Metadata/slice_info.config",
            f'<config><plate><metadata key="index" value="1"/>{plate}</plate></config>',
        )
    return path


def test_filament_contract_reads_materials_and_overrides_from_the_source(tmp_path):
    source = sliced(tmp_path / "job.3mf", (1, "PETG", "#0000FF"), (2, "PLA", "#FFFFFF"))
    required, overrides = filament_contract(source, 1, [{"slot_id": 2, "type": "PLA", "color": "#FF0000"}])
    assert json.loads(required) == ["PETG", "PLA"]
    assert json.loads(overrides) == [
        {"slot_id": 1, "type": "PETG", "color": "#0000FF", "force_color_match": True},
        {"slot_id": 2, "type": "PLA", "color": "#FF0000", "force_color_match": True},
    ]
    _, preferred = filament_contract(source, force_color_match=False)
    assert {override["force_color_match"] for override in json.loads(preferred)} == {False}


def test_filament_contract_without_a_readable_source(tmp_path):
    assert filament_contract(None) == (None, None)
    assert filament_contract(tmp_path / "missing.3mf") == (None, None)
    with pytest.raises(ValueError, match="sliced material metadata"):
        filament_contract(tmp_path / "missing.3mf", provided=[{"slot_id": 1, "type": "PLA", "color": "#FFFFFF"}])


def test_only_create_job_makes_a_waiting_job():
    # An externally started print is adopted while printing, by printing's entry (stage 6).
    allowed = {APP / "services/lifecycle/queued.py", APP / "services/lifecycle/printing.py"}
    makers = []
    for path in APP.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "PrintQueueItem":
                makers.append(path)
    assert makers and set(makers) <= allowed, sorted(str(path.relative_to(APP)) for path in set(makers) - allowed)
