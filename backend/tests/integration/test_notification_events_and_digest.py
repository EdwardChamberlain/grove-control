"""NotificationService: queue and stock events, Pushover / Telegram /
CallMeBot delivery, the daily digest and per-user print emails.

HTTP goes through an httpx MockTransport, so nothing leaves the test."""

import json
from datetime import datetime
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.notification import NotificationDigestQueue, NotificationLog
from backend.app.services.notification_service import NotificationService

pytestmark = pytest.mark.integration


class Recorder:
    """Collects outgoing requests and answers with a canned response."""

    def __init__(self, status=200, body=None):
        self.requests: list[httpx.Request] = []
        self.status = status
        self.body = body if body is not None else {"ok": True}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)


@pytest.fixture
def http():
    return Recorder()


@pytest.fixture
def service(http):
    svc = NotificationService()
    svc._http_client = httpx.AsyncClient(transport=httpx.MockTransport(http))
    return svc


@pytest.fixture
def session_maker(test_engine, monkeypatch):
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("backend.app.core.database.async_session", maker)
    return maker


async def _logs(db):
    return (await db.execute(select(NotificationLog).order_by(NotificationLog.id))).scalars().all()


class TestQueueAndStockEvents:
    @pytest.mark.parametrize(
        ("field", "call", "event"),
        [
            (
                "on_queue_job_added",
                lambda s, db, p: s.on_queue_job_added("Benchy", "Any X1C", db, p.id, "X1"),
                "queue_job_added",
            ),
            (
                "on_queue_job_assigned",
                lambda s, db, p: s.on_queue_job_assigned("Benchy", p.id, "X1", "X1C", db),
                "queue_job_assigned",
            ),
            (
                "on_queue_job_started",
                lambda s, db, p: s.on_queue_job_started("Benchy", p.id, "X1", db, estimated_time=5400),
                "queue_job_started",
            ),
            (
                "on_queue_job_waiting",
                lambda s, db, p: s.on_queue_job_waiting("Benchy", "X1C", "No PETG loaded", db),
                "queue_job_waiting",
            ),
            (
                "on_queue_job_skipped",
                lambda s, db, p: s.on_queue_job_skipped("Benchy", p.id, "X1", "previous failed", db),
                "queue_job_skipped",
            ),
            (
                "on_queue_job_failed",
                lambda s, db, p: s.on_queue_job_failed("Benchy", None, None, "upload error", db),
                "queue_job_failed",
            ),
            ("on_queue_completed", lambda s, db, p: s.on_queue_completed(4, db), "queue_completed"),
            (
                "on_stock_reorder_alert",
                lambda s, db, p: s.on_stock_reorder_alert("PLA", "Bambu", 400.4, 25.25, 16, db),
                "stock_reorder_alert",
            ),
            (
                "on_stock_break_alert",
                lambda s, db, p: s.on_stock_break_alert("PETG", None, 100, 50, 2, 7, db),
                "stock_break_alert",
            ),
        ],
    )
    async def test_sends_and_logs(
        self, service, http, db_session, printer_factory, notification_provider_factory, field, call, event
    ):
        printer = await printer_factory(name="X1")
        provider = await notification_provider_factory(**{field: True})

        await call(service, db_session, printer)

        assert len(http.requests) == 1
        logs = await _logs(db_session)
        assert [(log.event_type, log.success, log.provider_id) for log in logs] == [(event, True, provider.id)]

    async def test_no_subscribed_provider_sends_nothing(self, service, http, db_session, notification_provider_factory):
        await notification_provider_factory(on_queue_completed=False, on_stock_break_alert=False)

        await service.on_queue_completed(1, db_session)
        await service.on_stock_break_alert("PLA", None, 1, 1, 1, 1, db_session)
        for handler in (
            service.on_queue_job_added("j", "t", db_session),
            service.on_queue_job_assigned("j", 1, "p", "m", db_session),
            service.on_queue_job_started("j", 1, "p", db_session),
            service.on_stock_reorder_alert("PLA", None, 1, 1, 1, db_session),
        ):
            await handler

        assert http.requests == []


class TestProviders:
    async def _send(self, service, notification_provider_factory, provider_type, config, **kwargs):
        provider = await notification_provider_factory(provider_type=provider_type, config=config)
        return await service._send_to_provider(provider, "Done", "Benchy_plate_1 finished", **kwargs)

    async def test_pushover_with_and_without_image(self, service, http, notification_provider_factory):
        config = {"user_key": "u", "app_token": "a", "priority": 1}

        plain = await self._send(service, notification_provider_factory, "pushover", config)
        photo = await self._send(service, notification_provider_factory, "pushover", config, image_data=b"jpg")

        assert plain == photo == (True, "Message sent successfully")
        assert b"attachment" in http.requests[1].content

    async def test_pushover_errors(self, service, http, notification_provider_factory):
        missing = await self._send(service, notification_provider_factory, "pushover", {"user_key": " "})
        http.status, http.body = 400, {"errors": ["user key invalid"]}
        rejected = await self._send(
            service, notification_provider_factory, "pushover", {"user_key": "u", "app_token": "a"}
        )

        assert missing == (False, "User key and app token are required")
        assert rejected == (False, "Pushover error: user key invalid")

    async def test_telegram_escapes_body_and_sends_photo(self, service, http, notification_provider_factory):
        config = {"bot_token": "123:abc", "chat_id": "42"}

        text = await self._send(service, notification_provider_factory, "telegram", config)
        photo = await self._send(service, notification_provider_factory, "telegram", config, image_data=b"jpg")

        assert text == photo == (True, "Message sent successfully")
        assert json.loads(http.requests[0].content)["text"] == "*Done*\nBenchy\\_plate\\_1 finished"
        assert http.requests[1].url.path.endswith("/sendPhoto")

    @pytest.mark.parametrize(
        ("status", "body", "expected"),
        [
            (200, {"ok": False, "description": "chat not found"}, "Telegram error: chat not found"),
            (502, {"error": "bad gateway"}, "HTTP 502"),
        ],
    )
    async def test_telegram_errors(self, service, http, notification_provider_factory, status, body, expected):
        http.status, http.body = status, body

        ok, message = await self._send(
            service, notification_provider_factory, "telegram", {"bot_token": "t", "chat_id": "1"}
        )

        assert ok is False and message.startswith(expected)

    async def test_telegram_and_callmebot_need_config(self, service, notification_provider_factory):
        assert (await self._send(service, notification_provider_factory, "telegram", {}))[
            1
        ] == "Bot token and chat ID are required"
        assert (await self._send(service, notification_provider_factory, "callmebot", {}))[1] == (
            "Phone number and API key are required"
        )

    async def test_callmebot(self, service, http, notification_provider_factory):
        ok = await self._send(service, notification_provider_factory, "callmebot", {"phone": "+44", "apikey": "k"})
        http.status = 500
        failed = await self._send(service, notification_provider_factory, "callmebot", {"phone": "+44", "apikey": "k"})

        assert ok == (True, "Message sent successfully")
        assert failed[0] is False and failed[1].startswith("HTTP 500")
        assert "phone=%2B44" in str(http.requests[0].url) or "phone=+44" in str(http.requests[0].url)

    async def test_unknown_provider_type(self, service, notification_provider_factory):
        assert await self._send(service, notification_provider_factory, "carrier-pigeon", {}) == (
            False,
            "Unknown provider type: carrier-pigeon",
        )

    async def test_send_errors_are_reported_not_raised(self, service, notification_provider_factory):
        with patch.object(service, "_send_pushover", AsyncMock(side_effect=httpx.ConnectError("down"))):
            ok, message = await self._send(
                service, notification_provider_factory, "pushover", {"user_key": "u", "app_token": "a"}
            )

        assert (ok, message) == (False, "down")


class TestDigest:
    async def test_queues_then_sends_one_summary(
        self, service, http, db_session, session_maker, printer_factory, notification_provider_factory
    ):
        printer = await printer_factory(name="X1")
        provider = await notification_provider_factory(
            on_queue_job_waiting=True, on_queue_completed=True, daily_digest_enabled=True, daily_digest_time="08:00"
        )
        await service.on_queue_job_waiting("Benchy", "X1C", "no filament", db_session)
        await service.on_queue_job_skipped("Clip", printer.id, "X1", "failed", db_session)
        await service.on_queue_completed(2, db_session)
        queued = (await db_session.execute(select(NotificationDigestQueue))).scalars().all()
        assert len(queued) == 3
        http.requests.clear()

        await service.send_digest(provider.id)

        assert len(http.requests) == 1
        body = http.requests[0].content.decode()
        assert "== Queue Job Waiting (1) ==" in body
        assert "[X1]" in body
        async with session_maker() as db:
            assert (await db.execute(select(NotificationDigestQueue))).scalars().all() == []
            digest_logs = [log for log in await _logs(db) if log.event_type == "daily_digest"]
        assert digest_logs[0].title == "Daily Digest - 3 Events"

    async def test_failed_digest_is_logged_and_queue_cleared(
        self, service, http, session_maker, notification_provider_factory, db_session
    ):
        provider = await notification_provider_factory(daily_digest_enabled=True, daily_digest_time="08:00")
        db_session.add(NotificationDigestQueue(provider_id=provider.id, event_type="x", title="t", message="m"))
        await db_session.commit()
        http.status = 500

        await service.send_digest(provider.id)

        async with session_maker() as db:
            log = [log for log in await _logs(db) if log.event_type == "daily_digest"][0]
            assert log.success is False
            assert (await db.execute(select(NotificationDigestQueue))).scalars().all() == []

    async def test_nothing_to_send(self, service, http, session_maker, notification_provider_factory):
        enabled = await notification_provider_factory()
        disabled = await notification_provider_factory(enabled=False)

        for provider_id in (enabled.id, disabled.id, 9999):
            await service.send_digest(provider_id)

        assert http.requests == []

    async def test_scheduled_check_runs_due_providers_once_a_minute(
        self, service, session_maker, notification_provider_factory
    ):
        now = datetime.now().strftime("%H:%M")
        due = await notification_provider_factory(daily_digest_enabled=True, daily_digest_time=now)
        await notification_provider_factory(daily_digest_enabled=True, daily_digest_time="25:99")

        with patch.object(service, "send_digest", AsyncMock(side_effect=[RuntimeError("boom")])) as send:
            await service.check_and_send_digests()
            await service.check_and_send_digests()  # same minute: skipped

        send.assert_awaited_once_with(due.id)

    async def test_queue_failure_is_swallowed(self, service, db_session, notification_provider_factory):
        provider = await notification_provider_factory()

        with patch.object(db_session, "commit", AsyncMock(side_effect=RuntimeError("locked"))):
            await service._queue_for_digest(provider, "x", "t", "m", db_session)

    async def test_scheduler_start_stop(self, service):
        with patch.object(service, "_digest_scheduler_loop", AsyncMock()):
            service.start_digest_scheduler()
            task = service._digest_scheduler_task
            service.start_digest_scheduler()
            assert service._digest_scheduler_task is task
            service.stop_digest_scheduler()
        assert service._digest_scheduler_task is None
        service.stop_digest_scheduler()

    async def test_scheduler_loop_keeps_going_after_errors(self, service):
        check = AsyncMock(side_effect=RuntimeError("db down"))
        # The second sleep ends the loop; the first proves an error didn't stop it.
        sleep = AsyncMock(side_effect=[None, StopAsyncIteration])

        with (
            patch.object(service, "check_and_send_digests", check),
            patch("backend.app.services.notification_service.asyncio.sleep", sleep),
            pytest.raises(StopAsyncIteration),
        ):
            await service._digest_scheduler_loop()

        assert check.await_count == 2


class TestUserPrintEmail:
    @pytest.fixture
    async def user(self, db_session):
        from backend.app.models.user import User

        user = User(username="ada", email="ada@example.com", password_hash="x", is_active=True)
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)
        return user

    async def _settings(self, db, **values):
        from backend.app.models.settings import Settings

        for key, value in values.items():
            db.add(Settings(key=key, value=value))
        await db.commit()

    @pytest.fixture
    def mail(self):
        send = AsyncMock()
        with (
            patch("backend.app.services.email_service.get_smtp_settings", AsyncMock(return_value={"host": "smtp"})),
            patch("backend.app.services.email_service.send_user_print_notification", send),
        ):
            yield send

    async def test_sends_with_a_clean_filename(self, service, db_session, user, mail):
        await self._settings(db_session, advanced_auth_enabled="true")

        await service.send_user_print_email("user_print_complete", user.id, "X1", "Benchy.gcode.3mf", db_session)

        kwargs = mail.await_args.kwargs
        assert (kwargs["user_email"], kwargs["username"], kwargs["event_type"]) == (
            "ada@example.com",
            "ada",
            "user_print_complete",
        )
        assert kwargs["variables"]["printer"] == "X1"
        assert ".gcode" not in kwargs["variables"]["filename"]

    @pytest.mark.parametrize(
        "event", ["user_print_start", "user_print_complete", "user_print_failed", "user_print_stopped"]
    )
    async def test_respects_the_users_preferences(self, service, db_session, user, mail, event):
        from backend.app.models.user_email_pref import UserEmailPreference

        await self._settings(db_session, advanced_auth_enabled="true")
        db_session.add(
            UserEmailPreference(
                user_id=user.id,
                notify_print_start=False,
                notify_print_complete=False,
                notify_print_failed=False,
                notify_print_stopped=False,
            )
        )
        await db_session.commit()

        await service.send_user_print_email(event, user.id, "X1", "a.3mf", db_session)

        mail.assert_not_awaited()

    async def test_skips_when_not_applicable(self, service, db_session, user, mail):
        from backend.app.models.user import User

        # No submitter.
        await service.send_user_print_email("user_print_start", None, "X1", "a", db_session)
        # Advanced auth off.
        await service.send_user_print_email("user_print_start", user.id, "X1", "a", db_session)
        await self._settings(db_session, advanced_auth_enabled="true", user_notifications_enabled="false")
        # Admin switched user notifications off.
        await service.send_user_print_email("user_print_start", user.id, "X1", "a", db_session)

        mail.assert_not_awaited()

        from backend.app.models.settings import Settings

        setting = (
            await db_session.execute(select(Settings).where(Settings.key == "user_notifications_enabled"))
        ).scalar_one()
        setting.value = "true"
        no_email = User(username="bob", email=None, password_hash="x", is_active=True)
        db_session.add(no_email)
        await db_session.commit()
        # User without an email address, unknown user, unknown event.
        await service.send_user_print_email("user_print_start", no_email.id, "X1", "a", db_session)
        await service.send_user_print_email("user_print_start", 9999, "X1", "a", db_session)
        await service.send_user_print_email("user_print_paused", user.id, "X1", "a", db_session)

        mail.assert_not_awaited()

    async def test_skips_without_smtp_and_swallows_errors(self, service, db_session, user):
        await self._settings(db_session, advanced_auth_enabled="true")

        with patch("backend.app.services.email_service.get_smtp_settings", AsyncMock(return_value=None)):
            await service.send_user_print_email("user_print_start", user.id, "X1", "a", db_session)
        with patch("backend.app.services.email_service.get_smtp_settings", AsyncMock(side_effect=RuntimeError("db"))):
            await service.send_user_print_email("user_print_start", user.id, "X1", "a", db_session)
