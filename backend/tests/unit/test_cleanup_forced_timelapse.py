"""Tests for _cleanup_forced_timelapse (#1397).

When Bambuddy forced timelapse on for the finish-photo path, this helper
runs after the extractor (success OR failure — we never leave debris).
It deletes:
  - the locally-attached file (clears archive.timelapse_path)
  - the printer-side file via FTP DELE, walking the four scanner dirs

These tests pin the four branches:

  1. archive doesn't exist → no-op
  2. archive exists but bambuddy_forced_timelapse=False → no-op (user wanted
     the timelapse)
  3. archive exists, forced=True, local file present → delete local + DB
     update + FTP DELE on the first directory that succeeds
  4. archive exists, forced=True, but FTP DELE fails on every dir → local
     side still cleaned up; warn log emitted (best-effort)
"""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import main as main_module
from backend.app.main import _cleanup_forced_timelapse
from backend.app.services.bambu_ftp import DeleteResult


def _fake_session_factory(rows: dict):
    """Return an async_session() replacement that yields the given rows.

    `rows` is a mapping of model -> object that the test wants returned
    from `db.execute(select(...)).scalar_one_or_none()`. The select
    target is detected by walking the column descriptions — for these
    tests we just look at the model class name.
    """
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_session():
        async def execute(stmt):
            # The select(...) statement carries the target entity in
            # `stmt.column_descriptions[0]["entity"]`. Match by class name.
            target_name = stmt.column_descriptions[0]["entity"].__name__
            row = rows.get(target_name)
            return SimpleNamespace(scalar_one_or_none=lambda: row)

        commits: list[None] = []

        async def commit():
            commits.append(None)

        yield SimpleNamespace(execute=execute, commit=commit, _commits=commits)

    return fake_session


@pytest.fixture(autouse=True)
def patch_app_settings(monkeypatch, tmp_path):
    """Point base_dir at a tmp_path so the helper can resolve relative
    timelapse paths against a real fs we control."""
    monkeypatch.setattr(main_module.app_settings, "base_dir", tmp_path)
    return tmp_path


@pytest.mark.asyncio
async def test_no_archive_is_noop(monkeypatch):
    """Archive deleted between print start and cleanup? Don't crash."""
    monkeypatch.setattr(main_module, "async_session", _fake_session_factory({"PrintArchive": None, "Printer": None}))
    delete_mock = AsyncMock()
    with patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)
    delete_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_not_forced_is_noop(monkeypatch, tmp_path):
    """User wanted a timelapse → don't delete anything."""
    archive = SimpleNamespace(
        bambuddy_forced_timelapse=False,
        timelapse_path="archive/1/timelapse.mp4",
    )
    monkeypatch.setattr(
        main_module,
        "async_session",
        _fake_session_factory({"PrintArchive": archive, "Printer": None}),
    )

    # Lay down a real file so we'd detect a stray delete.
    video_path = tmp_path / archive.timelapse_path
    video_path.parent.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"x" * 100)

    delete_mock = AsyncMock(return_value=DeleteResult.DELETED)
    with patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)

    delete_mock.assert_not_awaited()
    assert video_path.exists()
    # archive.timelapse_path is untouched — we still have the user's video
    # tracked correctly.
    assert archive.timelapse_path == "archive/1/timelapse.mp4"


@pytest.mark.asyncio
async def test_forced_deletes_local_and_remote(monkeypatch, tmp_path):
    """Happy path: forced=True → local file unlinked, DB row cleared, FTP
    DELE called against /timelapse/<filename> (the first dir to succeed)."""
    archive = SimpleNamespace(
        bambuddy_forced_timelapse=True,
        timelapse_path="archive/1/myprint.mp4",
    )
    printer = SimpleNamespace(ip_address="10.0.0.5", access_code="12345678", model="O1C")
    monkeypatch.setattr(
        main_module,
        "async_session",
        _fake_session_factory({"PrintArchive": archive, "Printer": printer}),
    )

    video_path = tmp_path / archive.timelapse_path
    video_path.parent.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"x" * 100)

    # FTP DELE succeeds on the first directory we try.
    delete_mock = AsyncMock(return_value=DeleteResult.DELETED)
    with patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)

    # Local side: file gone, DB cleared.
    assert not video_path.exists()
    assert archive.timelapse_path is None
    # Remote side: DELE'd against /timelapse/myprint.mp4 — that's the
    # first dir the cleanup tries.
    delete_mock.assert_awaited()
    call = delete_mock.await_args
    assert call.args[0] == "10.0.0.5"
    assert call.args[1] == "12345678"
    assert call.args[2] == "/timelapse/myprint.mp4"


@pytest.mark.asyncio
async def test_forced_walks_alternate_dirs_when_first_fails(monkeypatch, tmp_path):
    """If /timelapse/ DELE returns False (file not there), try the other
    scanner dirs in order."""
    archive = SimpleNamespace(
        bambuddy_forced_timelapse=True,
        timelapse_path="archive/1/myprint.mp4",
    )
    printer = SimpleNamespace(ip_address="10.0.0.5", access_code="12345678", model="O1C")
    monkeypatch.setattr(
        main_module,
        "async_session",
        _fake_session_factory({"PrintArchive": archive, "Printer": printer}),
    )

    video_path = tmp_path / archive.timelapse_path
    video_path.parent.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"x" * 100)

    # First two dirs report NOT_FOUND (file not there), third succeeds.
    # Cleanup should stop after the third — and crucially must NOT WARN
    # because no real network/auth failure happened (#1721).
    delete_mock = AsyncMock(side_effect=[DeleteResult.NOT_FOUND, DeleteResult.NOT_FOUND, DeleteResult.DELETED])
    with patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)

    assert delete_mock.await_count == 3
    paths_tried = [call.args[2] for call in delete_mock.await_args_list]
    assert paths_tried == [
        "/timelapse/myprint.mp4",
        "/timelapse/video/myprint.mp4",
        "/record/myprint.mp4",
    ]


@pytest.mark.asyncio
async def test_forced_local_cleanup_runs_even_if_ftp_unreachable(monkeypatch, tmp_path):
    """FTP completely failing must not block local cleanup — the user's
    archive UI should reflect that the timelapse is gone immediately,
    even if the printer-side file lingers."""
    archive = SimpleNamespace(
        bambuddy_forced_timelapse=True,
        timelapse_path="archive/1/myprint.mp4",
    )
    printer = SimpleNamespace(ip_address="10.0.0.5", access_code="12345678", model="O1C")
    monkeypatch.setattr(
        main_module,
        "async_session",
        _fake_session_factory({"PrintArchive": archive, "Printer": printer}),
    )

    video_path = tmp_path / archive.timelapse_path
    video_path.parent.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"x" * 100)

    # Every FTP attempt throws.
    delete_mock = AsyncMock(side_effect=OSError("connection refused"))
    with patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)

    # Local side cleaned up even though all FTP attempts threw.
    assert not video_path.exists()
    assert archive.timelapse_path is None
    # All four dirs were attempted before giving up.
    assert delete_mock.await_count == 4


@pytest.mark.asyncio
async def test_forced_no_warning_when_every_dir_returns_not_found(monkeypatch, tmp_path, caplog):
    """#1721: when every candidate dir returns 550 (file not there) the
    helper used to emit "Could not delete printer-side timelapse ...
    (file may already be gone)" at WARNING. That message landed in support
    bundles for healthy printers whose firmware swept the SD card itself.
    With DeleteResult.NOT_FOUND signalling, no real failure happened →
    must be DEBUG, not WARNING.
    """
    import logging

    archive = SimpleNamespace(
        bambuddy_forced_timelapse=True,
        timelapse_path="archive/1/myprint.mp4",
    )
    printer = SimpleNamespace(ip_address="10.0.0.5", access_code="12345678", model="N2S")
    monkeypatch.setattr(
        main_module,
        "async_session",
        _fake_session_factory({"PrintArchive": archive, "Printer": printer}),
    )

    video_path = tmp_path / archive.timelapse_path
    video_path.parent.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"x" * 100)

    delete_mock = AsyncMock(return_value=DeleteResult.NOT_FOUND)
    with (
        caplog.at_level(logging.DEBUG, logger="backend.app.main"),
        patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock),
    ):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)

    assert delete_mock.await_count == 4
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING and "[FORCED-TIMELAPSE]" in r.message]
    assert warnings == [], f"unexpected WARNING(s): {[w.message for w in warnings]}"
    debugs = [
        r for r in caplog.records if r.levelno == logging.DEBUG and "No printer-side timelapse to delete" in r.message
    ]
    assert len(debugs) == 1, "expected the 'nothing to delete' debug summary"


@pytest.mark.asyncio
async def test_forced_warns_when_any_dir_returns_failed(monkeypatch, tmp_path, caplog):
    """Counterpart to the above: a real network/auth/transient FAILED on any
    dir keeps the WARNING — that's the signal the maintainer actually wants
    to see.
    """
    import logging

    archive = SimpleNamespace(
        bambuddy_forced_timelapse=True,
        timelapse_path="archive/1/myprint.mp4",
    )
    printer = SimpleNamespace(ip_address="10.0.0.5", access_code="12345678", model="O1C")
    monkeypatch.setattr(
        main_module,
        "async_session",
        _fake_session_factory({"PrintArchive": archive, "Printer": printer}),
    )

    video_path = tmp_path / archive.timelapse_path
    video_path.parent.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"x" * 100)

    delete_mock = AsyncMock(
        side_effect=[
            DeleteResult.NOT_FOUND,
            DeleteResult.FAILED,
            DeleteResult.NOT_FOUND,
            DeleteResult.NOT_FOUND,
        ]
    )
    with (
        caplog.at_level(logging.WARNING, logger="backend.app.main"),
        patch("backend.app.services.bambu_ftp.delete_file_async", new=delete_mock),
    ):
        await _cleanup_forced_timelapse(archive_id=99, printer_id=10)

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING and "[FORCED-TIMELAPSE]" in r.message]
    assert len(warnings) == 1
    assert "network/auth/transient" in warnings[0].message
