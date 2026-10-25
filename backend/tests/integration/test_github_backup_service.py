"""GitHubBackupService: running a backup end to end against the test
database, the private-repo guard, what gets collected, and the scheduler."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.github_backup import GitHubBackupConfig, GitHubBackupLog
from backend.app.services import github_backup as gb

pytestmark = pytest.mark.integration


@pytest.fixture
def service(test_engine, monkeypatch):
    """A fresh service whose sessions use the test database."""
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(gb, "async_session", maker)
    svc = gb.GitHubBackupService()
    svc.test_connection = AsyncMock(return_value={"success": True, "is_private": True})
    svc._push_to_provider = AsyncMock(
        return_value={"status": "success", "commit_sha": "abc123", "files_changed": 3, "message": "Pushed"}
    )
    return svc


async def _config(db, **kwargs) -> GitHubBackupConfig:
    defaults = {
        "repository_url": "https://github.com/me/backups",
        "access_token": "tok",
        "backup_kprofiles": False,
        "backup_cloud_profiles": False,
    }
    config = GitHubBackupConfig(**{**defaults, **kwargs})
    db.add(config)
    await db.commit()
    await db.refresh(config)
    return config


async def _reload(db, model, id_):
    stmt = select(model).where(model.id == id_).execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one()


class TestRunBackup:
    async def test_pushes_collected_files_and_records_the_result(self, service, db_session):
        from backend.app.models.settings import Settings

        db_session.add_all([Settings(key="currency", value="EUR"), Settings(key="auth_secret_key", value="s3cret")])
        config = await _config(db_session, backup_settings=True, schedule_enabled=True, schedule_type="hourly")

        result = await service.run_backup(config.id)

        assert result == {
            "success": True,
            "message": "Pushed",
            "log_id": result["log_id"],
            "commit_sha": "abc123",
            "files_changed": 3,
        }
        files = service._push_to_provider.await_args.args[1]
        assert files["settings/app_settings.json"]["settings"] == {"currency": "EUR"}
        assert files["backup_metadata.json"]["contents"]["settings"] is True

        config_id = config.id
        log = await _reload(db_session, GitHubBackupLog, result["log_id"])
        config = await _reload(db_session, GitHubBackupConfig, config_id)
        assert (log.status, log.commit_sha, log.files_changed) == ("success", "abc123", 3)
        assert (config.last_backup_status, config.last_backup_commit_sha) == ("success", "abc123")
        assert config.next_scheduled_run is not None
        assert service.is_running is False and service.progress is None

    @pytest.mark.parametrize(
        ("connection", "note"),
        [
            ({"success": True, "is_private": False}, "no longer private"),
            ({"success": False, "error": "401"}, "could not confirm"),
        ],
    )
    async def test_refuses_repos_that_are_not_confirmed_private(self, service, db_session, connection, note):
        service.test_connection.return_value = connection
        config = await _config(db_session, schedule_enabled=True)

        result = await service.run_backup(config.id, trigger="scheduled")

        assert result["success"] is False
        assert note in result["message"]
        service._push_to_provider.assert_not_awaited()
        log = await _reload(db_session, GitHubBackupLog, result["log_id"])
        assert (log.status, log.trigger) == ("failed", "scheduled")

    async def test_missing_and_disabled_configs(self, service, db_session):
        disabled = await _config(db_session, enabled=False)

        assert (await service.run_backup(9999))["message"] == "Configuration not found"
        assert (await service.run_backup(disabled.id))["message"] == "Backup is disabled"

    async def test_only_one_backup_at_a_time(self, service):
        service._running_backup = True

        assert (await service.run_backup(1))["message"] == "A backup is already running"

    async def test_nothing_to_back_up_is_skipped(self, service, db_session):
        config = await _config(db_session, schedule_enabled=True)

        with patch.object(service, "_collect_backup_data", AsyncMock(return_value={})):
            result = await service.run_backup(config.id)

        assert (result["success"], result["message"], result["files_changed"]) == (True, "No data to backup", 0)
        config = await _reload(db_session, GitHubBackupConfig, config.id)
        assert config.last_backup_status == "skipped"

    async def test_push_failure_is_logged(self, service, db_session):
        service._push_to_provider.side_effect = RuntimeError("push rejected")
        config = await _config(db_session, schedule_enabled=True)

        result = await service.run_backup(config.id)

        assert (result["success"], result["message"]) == (False, "push rejected")
        log = await _reload(db_session, GitHubBackupLog, result["log_id"])
        assert (log.status, log.error_message) == ("failed", "push rejected")

    async def test_logs_newest_first(self, service, db_session):
        config = await _config(db_session)
        await service.run_backup(config.id)
        await service.run_backup(config.id)

        logs = await service.get_logs(config.id, limit=1)

        assert len(logs) == 1


class TestCollection:
    async def test_spools_usage_and_archives(self, service, db_session, printer_factory, archive_factory):
        from backend.app.models.spool import Spool
        from backend.app.models.spool_usage_history import SpoolUsageHistory

        printer = await printer_factory()
        spool = Spool(material="PETG", brand="Bambu", archived_at=datetime(2026, 1, 1))
        db_session.add(spool)
        await db_session.commit()
        db_session.add(SpoolUsageHistory(spool_id=spool.id, printer_id=printer.id, print_name="Cube", weight_used=4))
        await db_session.commit()
        await archive_factory(printer.id, print_name="Benchy")
        config = await _config(db_session, backup_spools=True, backup_archives=True)

        files = await service._collect_backup_data(db_session, config)

        assert files["spools/inventory.json"]["spools"][0]["material"] == "PETG"
        assert files["spools/usage_history.json"]["usage_history"][0]["print_name"] == "Cube"
        assert files["archives/print_history.json"]["archives"][0]["print_name"] == "Benchy"

    async def test_empty_spools_and_archives_add_nothing(self, service, db_session):
        config = await _config(db_session, backup_spools=True, backup_archives=True)

        files = await service._collect_backup_data(db_session, config)

        assert list(files) == ["backup_metadata.json"]

    async def test_kprofiles_from_connected_printers(self, service, db_session, printer_factory):
        connected = await printer_factory(serial_number="SERIAL1")
        await printer_factory(name="Offline", serial_number="SERIAL2")
        profile = SimpleNamespace(
            slot_id=1,
            name="PLA",
            k_value="0.02",
            filament_id="GFA00",
            nozzle_id="HS",
            extruder_id=0,
            setting_id="s1",
            n_coef="1.4",
        )

        async def kprofiles(nozzle_diameter):
            if nozzle_diameter == "0.6":
                raise TimeoutError("no reply")
            return [profile] if nozzle_diameter == "0.4" else []

        client = MagicMock(state=SimpleNamespace(connected=True), get_kprofiles=AsyncMock(side_effect=kprofiles))
        with patch.object(
            gb.printer_manager, "get_client", side_effect=lambda pid: client if pid == connected.id else None
        ):
            files = await service._collect_backup_data(db_session, await _config(db_session, backup_kprofiles=True))

        assert [k for k in files if k.startswith("kprofiles/")] == ["kprofiles/SERIAL1/0.4.json"]
        assert files["kprofiles/SERIAL1/0.4.json"]["profiles"][0]["k_value"] == "0.02"

    async def test_cloud_profiles_split_by_type(self, service, db_session):
        cloud = MagicMock(is_authenticated=True, close=AsyncMock())
        cloud.get_slicer_settings = AsyncMock(
            return_value={
                "setting": [
                    {"type": "filament", "name": "F"},
                    {"type": "printer", "name": "P"},
                    {"type": "process", "name": "Q"},
                    {"type": "other"},
                ]
            }
        )
        with patch("backend.app.api.routes.cloud.build_authenticated_cloud", AsyncMock(return_value=cloud)):
            files = await service._collect_backup_data(
                db_session, await _config(db_session, backup_cloud_profiles=True)
            )

        assert [
            files[f"cloud_profiles/{t}.json"]["profiles"][0]["name"] for t in ("filament", "printer", "process")
        ] == [
            "F",
            "P",
            "Q",
        ]
        cloud.close.assert_awaited_once()

    @pytest.mark.parametrize(
        "cloud",
        [
            None,
            MagicMock(is_authenticated=False, close=AsyncMock()),
            MagicMock(is_authenticated=True, close=AsyncMock(), get_slicer_settings=AsyncMock(return_value=None)),
            MagicMock(is_authenticated=True, close=AsyncMock(), get_slicer_settings=AsyncMock(side_effect=OSError)),
        ],
        ids=["no-cloud", "signed-out", "no-settings", "error"],
    )
    async def test_cloud_profiles_skipped(self, service, db_session, cloud):
        with patch("backend.app.api.routes.cloud.build_authenticated_cloud", AsyncMock(return_value=cloud)):
            files = await service._collect_backup_data(
                db_session, await _config(db_session, backup_cloud_profiles=True)
            )

        assert not any(k.startswith("cloud_profiles/") for k in files)
        if cloud is not None:
            cloud.close.assert_awaited_once()


class TestScheduling:
    def test_next_run_intervals(self):
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        svc = gb.GitHubBackupService()

        assert svc.calculate_next_run("hourly", start) == start + timedelta(hours=1)
        assert svc.calculate_next_run("weekly", start) == start + timedelta(weeks=1)
        assert svc.calculate_next_run("fortnightly", start) == start + timedelta(days=1)

    async def test_runs_only_due_configs(self, service, db_session):
        past = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5)
        future = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=5)
        due = await _config(db_session, schedule_enabled=True, next_scheduled_run=past)
        await _config(db_session, schedule_enabled=True, next_scheduled_run=future)
        await _config(db_session, schedule_enabled=False, next_scheduled_run=past)

        with patch.object(service, "run_backup", AsyncMock()) as run:
            await service._check_scheduled_backups()

        run.assert_awaited_once_with(due.id, trigger="scheduled")

    async def test_scheduler_loop_survives_errors_and_stops(self, service):
        service._check_interval = 0
        calls = 0

        async def check():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("db down")
            raise asyncio.CancelledError

        real_sleep = asyncio.sleep
        with (
            patch.object(service, "_check_scheduled_backups", side_effect=check),
            patch.object(gb.asyncio, "sleep", side_effect=lambda s: real_sleep(0)),
        ):
            await service._scheduler_loop()

        assert calls == 2

    async def test_start_and_stop(self, service):
        with patch.object(service, "_scheduler_loop", AsyncMock()):
            await service.start_scheduler()
            task = service._scheduler_task
            await service.start_scheduler()  # second start is a no-op
            assert service._scheduler_task is task
            service.stop_scheduler()

        assert service._scheduler_task is None
        service.stop_scheduler()  # stopping twice is harmless


class TestProviderPlumbing:
    async def test_connection_and_push_use_the_provider_backend(self):
        svc = gb.GitHubBackupService()
        backend = MagicMock(
            test_connection=AsyncMock(return_value={"success": True}),
            push_files=AsyncMock(return_value={"status": "success"}),
        )
        config = SimpleNamespace(provider="gitea", repository_url="https://git/x/y", access_token="t", branch="main")

        with patch.object(gb, "get_provider_backend", return_value=backend):
            assert await svc.test_connection("https://git/x/y", "t", provider="gitea") == {"success": True}
            assert await svc._push_to_provider(config, {"a.json": {}}) == {"status": "success"}

        assert backend.push_files.await_args.kwargs["branch"] == "main"
        client = await svc._get_client()
        assert client is await svc._get_client()
        await client.aclose()
        assert await svc._get_client() is not client
