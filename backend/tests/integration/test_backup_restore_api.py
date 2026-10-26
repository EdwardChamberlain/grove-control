"""Full backup and restore (settings routes) against a throwaway database
file and data directory.

Only the global engine and the service restarts are stubbed; the database
file copy, data-directory copy and MFA key handling run for real.
"""

import io
import sqlite3
import zipfile
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

pytestmark = pytest.mark.integration


def _sqlite_file(path, value: str):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE marker (value TEXT)")
    conn.execute("INSERT INTO marker VALUES (?)", (value,))
    conn.commit()
    conn.close()


def _marker(path) -> str:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT value FROM marker").fetchone()[0]
    finally:
        conn.close()


@pytest.fixture
def data(tmp_path, monkeypatch):
    from backend.app.core.config import settings

    live_db = tmp_path / "live.db"
    _sqlite_file(live_db, "live")
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{live_db}")
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "plate_calibration_dir", tmp_path / "plate_calibration")
    (tmp_path / "archive").mkdir()
    (tmp_path / "archive/old.txt").write_text("old")
    (tmp_path / "keys").mkdir()
    monkeypatch.setattr("backend.app.core.paths.resolve_data_dir", lambda: tmp_path / "keys")
    return tmp_path


class TestBackup:
    async def test_zip_contains_database_files_and_mfa_key(self, async_client: AsyncClient, data):
        (data / "icons").mkdir()
        (data / "icons/logo.png").write_bytes(b"png")
        (data / "keys/.mfa_encryption_key").write_bytes(b"secret-key")
        engine = create_async_engine(f"sqlite+aiosqlite:///{data / 'live.db'}")

        try:
            with patch("backend.app.core.database.engine", engine):
                response = await async_client.get("/api/v1/settings/backup")
        finally:
            await engine.dispose()

        assert response.status_code == 200
        assert "bambuddy-backup-" in response.headers["content-disposition"]
        with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
            names = set(zf.namelist())
            backup_db = data / "extracted.db"
            backup_db.write_bytes(zf.read("bambuddy.db"))
        assert {"bambuddy.db", "archive/old.txt", "icons/logo.png", ".mfa_encryption_key"} <= names
        assert _marker(backup_db) == "live"

    async def test_failure_returns_500(self, async_client: AsyncClient, data):
        with patch("backend.app.api.routes.settings.create_backup_zip", AsyncMock(side_effect=OSError("disk full"))):
            response = await async_client.get("/api/v1/settings/backup")

        assert response.status_code == 500
        assert response.json() == {"success": False, "message": "Backup failed. Check server logs for details."}


def _backup_zip(data_dir, extra: dict[str, bytes] | None = None, include_db=True) -> bytes:
    restored_db = data_dir / "restored-source.db"
    if include_db:
        _sqlite_file(restored_db, "restored")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if include_db:
            zf.write(restored_db, "bambuddy.db")
        for name, content in (extra or {}).items():
            zf.writestr(name, content)
    return buf.getvalue()


@pytest.fixture
def restore_infra():
    stubs = {
        "close_all_connections": AsyncMock(),
        "reinitialize_database": AsyncMock(),
        "init_db": AsyncMock(),
    }
    with (
        patch("backend.app.core.database.close_all_connections", stubs["close_all_connections"]),
        patch("backend.app.core.database.reinitialize_database", stubs["reinitialize_database"]),
        patch("backend.app.core.database.init_db", stubs["init_db"]),
        patch("asyncio.sleep", AsyncMock()),
    ):
        yield stubs


class TestRestore:
    async def _restore(self, client, content, name="backup.zip"):
        return await client.post("/api/v1/settings/restore", files={"file": (name, content, "application/zip")})

    async def test_replaces_database_data_and_mfa_key(self, async_client: AsyncClient, data, restore_infra):
        content = _backup_zip(
            data, {"archive/new.txt": b"new", "archive/sub/deep.txt": b"deep", ".mfa_encryption_key": b"restored-key"}
        )

        response = await self._restore(async_client, content)

        assert response.json()["success"] is True
        assert _marker(data / "live.db") == "restored"
        assert not (data / "archive/old.txt").exists()
        assert (data / "archive/new.txt").read_text() == "new"
        assert (data / "archive/sub/deep.txt").read_text() == "deep"
        key = data / "keys/.mfa_encryption_key"
        assert key.read_bytes() == b"restored-key"
        assert key.stat().st_mode & 0o777 == 0o600
        restore_infra["close_all_connections"].assert_awaited_once()
        restore_infra["reinitialize_database"].assert_awaited_once()

    @pytest.mark.parametrize(
        ("name", "content", "detail"),
        [
            ("backup.tar", b"x", "Invalid backup file: must be a .zip file"),
            ("backup.zip", b"not a zip", "Invalid backup file: not a valid ZIP"),
        ],
    )
    async def test_rejects_non_zip_files(self, async_client: AsyncClient, data, restore_infra, name, content, detail):
        response = await self._restore(async_client, content, name=name)

        assert (response.status_code, response.json()["detail"]) == (400, detail)

    async def test_rejects_paths_that_escape_the_backup(self, async_client: AsyncClient, data, restore_infra):
        content = _backup_zip(data, {"../../escaped.txt": b"x"})

        response = await self._restore(async_client, content)

        assert response.status_code == 400
        assert "unsafe path" in response.json()["detail"]
        assert not (data.parent / "escaped.txt").exists()
        assert _marker(data / "live.db") == "live"

    async def test_rejects_backup_without_database(self, async_client: AsyncClient, data, restore_infra):
        response = await self._restore(async_client, _backup_zip(data, {"archive/x.txt": b"x"}, include_db=False))

        assert (response.status_code, response.json()["detail"]) == (400, "Invalid backup: missing bambuddy.db")
        restore_infra["close_all_connections"].assert_not_awaited()

    async def test_unexpected_failure_returns_500(self, async_client: AsyncClient, data, restore_infra):
        restore_infra["reinitialize_database"].side_effect = RuntimeError("engine gone")

        response = await self._restore(async_client, _backup_zip(data))

        assert response.status_code == 500
        assert response.json()["success"] is False
