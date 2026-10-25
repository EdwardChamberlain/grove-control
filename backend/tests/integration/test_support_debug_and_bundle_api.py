"""Debug logging toggle and the support bundle (routes/support.py)."""

import io
import json
import logging
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes import support
from backend.app.models.settings import Settings

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def restore_log_levels():
    """_apply_log_level changes global logger levels; put them back."""
    root = logging.getLogger()
    saved = (root.level, [h.level for h in root.handlers], logging.getLogger("paho.mqtt").level)
    yield
    root.setLevel(saved[0])
    for handler, level in zip(root.handlers, saved[1], strict=False):
        handler.setLevel(level)
    logging.getLogger("paho.mqtt").setLevel(saved[2])


@pytest.fixture
def session(test_engine):
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("backend.app.api.routes.support.async_session", maker):
        yield maker


@pytest.fixture
def logs(tmp_path, monkeypatch):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "log_dir", tmp_path)
    return tmp_path / "bambuddy.log"


class TestDebugLogging:
    async def test_defaults_to_off(self, async_client: AsyncClient, session):
        body = (await async_client.get("/api/v1/support/debug-logging")).json()
        assert body == {"enabled": False, "enabled_at": None, "duration_seconds": None}

    async def test_enable_then_disable(self, async_client: AsyncClient, session):
        enabled = (await async_client.post("/api/v1/support/debug-logging", json={"enabled": True})).json()
        state = (await async_client.get("/api/v1/support/debug-logging")).json()

        assert enabled["enabled"] is True
        assert enabled["enabled_at"] is not None
        assert logging.getLogger().level == logging.DEBUG
        assert logging.getLogger("httpx").level == logging.WARNING  # never logs webhook URLs
        assert (state["enabled"], state["duration_seconds"] >= 0) == (True, True)

        disabled = (await async_client.post("/api/v1/support/debug-logging", json={"enabled": False})).json()

        assert disabled == {"enabled": False, "enabled_at": None, "duration_seconds": None}
        assert logging.getLogger().level == logging.INFO

    async def test_malformed_and_naive_timestamps(self, session):
        async with session() as db:
            db.add_all(
                [
                    Settings(key="debug_logging_enabled", value="true"),
                    Settings(key="debug_logging_enabled_at", value="soon"),
                ]
            )
            await db.commit()
            assert await support._get_debug_setting(db) == (True, None)

            row = (
                await db.execute(Settings.__table__.select().where(Settings.key == "debug_logging_enabled_at"))
            ).first()
            await db.execute(
                Settings.__table__.update().where(Settings.id == row.id).values(value="2026-01-01T10:00:00")
            )
            await db.commit()
            enabled, enabled_at = await support._get_debug_setting(db)

        assert enabled_at.tzinfo is not None

    async def test_restored_on_startup(self, session):
        async with session() as db:
            db.add(Settings(key="debug_logging_enabled", value="true"))
            await db.commit()

        await support.init_debug_logging()

        assert logging.getLogger().level == logging.DEBUG

    async def test_startup_restore_survives_database_errors(self):
        broken = MagicMock(side_effect=RuntimeError("db down"))
        with patch("backend.app.api.routes.support.async_session", broken):
            await support.init_debug_logging()


class TestLogContent:
    def test_missing_log(self, logs):
        assert support._get_log_content() == b"Log file not found"

    def test_large_log_keeps_the_tail_and_redacts(self, logs):
        logs.write_text("first line\n" + "x" * 100 + "\nsecret ABC123 here\n")

        content = support._get_log_content(max_bytes=40, sensitive_strings={"ABC123": "[ACCESS_CODE]"}).decode()

        assert "first line" not in content
        assert "secret [ACCESS_CODE] here" in content

    async def test_recent_sanitized_lines(self, logs, session):
        logs.write_text("\n".join(f"line {i}" for i in range(10)))

        assert (await support._get_recent_sanitized_logs(max_lines=3)).splitlines() == ["line 7", "line 8", "line 9"]

    async def test_recent_lines_without_a_log(self, logs, session):
        assert await support._get_recent_sanitized_logs() == ""


class TestRedactPushStatus:
    def test_drops_private_keys_and_scrubs_ips(self):
        raw = {
            "subtask_name": "secret.3mf",
            "ams": [{"id": "0", "task_id": "1"}],
            "net": {"info": [{"ip": 3232235876, "mask": 1}, "junk"]},
        }

        assert support._redact_raw_push_status(raw) == {
            "ams": [{"id": "0"}],
            "net": {"info": [{"ip": "0.0.0.0", "mask": 1}, "junk"]},
        }
        assert raw["subtask_name"] == "secret.3mf"  # original untouched

    def test_non_dict(self):
        assert support._redact_raw_push_status(["x"]) == {}


class TestSupportBundle:
    async def test_requires_debug_logging(self, async_client: AsyncClient, session):
        response = await async_client.get("/api/v1/support/bundle")

        assert response.status_code == 400
        assert "Debug logging must be enabled" in response.json()["detail"]

    async def test_bundle_contents_are_redacted(self, async_client: AsyncClient, session, logs, printer_factory):
        printer = await printer_factory(name="Garage X1", access_code="87654321")
        async with session() as db:
            db.add(Settings(key="debug_logging_enabled", value="true"))
            await db.commit()
        logs.write_text("connected to Garage X1 with code 87654321\n")
        state = SimpleNamespace(
            raw_data={"subtask_name": "private.3mf", "ams": [{"id": "0"}], "net": {"info": [{"ip": 1}]}},
            firmware_version="01.08.00.00",
        )
        pm = MagicMock(get_all_statuses=MagicMock(return_value={printer.id: state}))

        with (
            patch("backend.app.api.routes.support.printer_manager", pm),
            patch("backend.app.api.routes.support._collect_support_info", AsyncMock(return_value={"app": "ok"})),
        ):
            response = await async_client.get("/api/v1/support/bundle")

        assert response.status_code == 200
        assert "bambuddy-support-" in response.headers["content-disposition"]
        with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
            names = set(zf.namelist())
            info = json.loads(zf.read("support-info.json"))
            snapshot = json.loads(zf.read("push-status/printer-1.json"))
            log = zf.read("bambuddy.log").decode()
        assert names == {"support-info.json", "push-status/printer-1.json", "bambuddy.log"}
        assert info == {"app": "ok"}
        assert (snapshot["model"], snapshot["firmware_version"]) == ("X1C", "01.08.00.00")
        assert "subtask_name" not in snapshot["raw_data"]
        assert snapshot["raw_data"]["net"]["info"][0]["ip"] in ("0.0.0.0", "[IP]")
        assert "Garage X1" not in log and "87654321" not in log


class TestCollectSupportInfo:
    async def test_collects_counts_printers_and_settings_without_secrets(
        self, session, printer_factory, archive_factory, db_session
    ):
        from backend.app.models.settings import Settings as SettingsRow

        printer = await printer_factory(name="Garage X1", model="X1C")
        await archive_factory(printer.id, status="completed")
        db_session.add_all(
            [
                SettingsRow(key="obico_enabled_printers", value=f"[{printer.id}]"),
                SettingsRow(key="mqtt_broker", value="broker.example.com"),
                SettingsRow(key="mqtt_password", value="hunter2"),
            ]
        )
        await db_session.commit()
        from backend.app.services.bambu_mqtt import PrinterState

        state = PrinterState()
        state.connected = True
        state.state = "IDLE"
        state.firmware_version = "01.08.00.00"
        state.raw_data = {"ams": [{"id": "0", "module_type": "n3f"}]}
        state.wifi_signal = -55
        pm = MagicMock(get_all_statuses=MagicMock(return_value={printer.id: state}))

        with (
            patch("backend.app.api.routes.support.printer_manager", pm),
            patch("backend.app.api.routes.support._check_port", AsyncMock(return_value=True)),
            patch("backend.app.api.routes.support._collect_slicer_api_info", AsyncMock(return_value={})),
            patch("backend.app.api.routes.support._check_url_reachable", AsyncMock(return_value=None)),
            patch("backend.app.core.database.async_session", session),
        ):
            info = await support._collect_support_info()

        assert info["database"]["archives_total"] == 1
        assert info["database"]["archives_completed"] == 1
        assert info["database"]["printers_total"] == 1
        dumped = json.dumps(info, default=str)
        assert "hunter2" not in dumped
        assert "Garage X1" not in dumped
