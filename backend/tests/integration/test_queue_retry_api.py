"""Retry keeps the job's candidate snapshots and respects priority permissions."""

import pytest
from sqlalchemy import func, select

from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant


async def test_retry_clears_legacy_manual_start_after_heat_soak_abort(
    async_client, db_session, printer_factory, tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    printer = await printer_factory()
    source = await _source(db_session, tmp_path / "soak.3mf", "X1C")
    old = PrintQueueItem(
        printer_id=printer.id,
        library_file_id=source.id,
        status="failed",
        chamber_heat_soak=True,
        heat_soak_minutes=10,
        manual_start=True,
    )
    db_session.add(old)
    await db_session.commit()
    response = await async_client.post(f"/api/v1/queue/{old.id}/retry")
    assert response.status_code == 200, response.text
    retry = response.json()
    assert retry["manual_start"] is False
    assert retry["status"] == "queued"
    assert retry["chamber_heat_soak"] is True and retry["heat_soak_minutes"] == 10
    assert retry["id"] != old.id
    await db_session.refresh(old)
    assert old.status == "failed" and old.manual_start is True


async def _source(db, path, model):
    path.write_bytes(b"print source")
    source = LibraryFile(
        filename=path.name,
        file_path=str(path),
        file_size=path.stat().st_size,
        file_type="3mf",
        file_metadata={"sliced_for_model": model},
    )
    db.add(source)
    await db.flush()
    return source


@pytest.mark.parametrize("missing", [None, "selected", "alternative"])
async def test_retry_preserves_available_candidate_snapshots(
    async_client, db_session, printer_factory, tmp_path, monkeypatch, missing
):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    printer = await printer_factory(model="H2S")
    a = await _source(db_session, tmp_path / "h2s.3mf", "H2S")
    b = await _source(db_session, tmp_path / "h2c.3mf", "H2C")
    old = PrintQueueItem(
        printer_id=printer.id,
        library_file_id=a.id,
        target_model="H2S",
        status="failed",
        chamber_heat_soak=True,
        force_color_match=False,
    )
    old.variants = [
        PrintQueueVariant(
            library_file_id=a.id,
            target_model="H2S",
            position=0,
            plate_id=1,
            ams_mapping="[1]",
            required_filament_types='["PLA"]',
            filament_overrides='[{"slot_id": 1, "type": "PLA", "color": "#123456"}]',
            print_time_seconds=600,
            attempt_count=2,
        ),
        PrintQueueVariant(
            library_file_id=b.id,
            target_model="H2C",
            position=1,
            plate_id=2,
            ams_mapping="[2, 3]",
            nozzle_mapping="[1, 2]",
            required_filament_types='["PETG"]',
            filament_overrides='[{"slot_id": 2, "type": "PETG", "color": "#654321"}]',
            print_time_seconds=300,
            attempt_count=3,
        ),
    ]
    waiting = PrintQueueItem(target_model="H2D", status="queued", position=-30)
    waiting.variants = [PrintQueueVariant(library_file_id=b.id, target_model="H2C", position=0)]
    db_session.add_all([old, waiting, PrintQueueItem(target_model="H2S", status="queued", position=-20)])
    await db_session.commit()
    if missing:
        (tmp_path / ("h2s.3mf" if missing == "selected" else "h2c.3mf")).unlink()

    response = await async_client.post(f"/api/v1/queue/{old.id}/retry")
    assert response.status_code == 200, response.text
    body = response.json()
    candidates = list(
        (
            await db_session.scalars(
                select(PrintQueueVariant)
                .where(PrintQueueVariant.queue_item_id == body["id"])
                .order_by(PrintQueueVariant.position)
            )
        ).all()
    )
    originals = [
        v for v in old.variants if not missing or v.library_file_id != (a.id if missing == "selected" else b.id)
    ]
    assert len(candidates) == len(originals)
    for candidate, original in zip(candidates, originals, strict=True):
        for field in (
            "library_file_id",
            "target_model",
            "position",
            "plate_id",
            "ams_mapping",
            "nozzle_mapping",
            "filament_overrides",
            "required_filament_types",
            "print_time_seconds",
        ):
            assert getattr(candidate, field) == getattr(original, field)
        assert candidate.attempt_count == 0 and candidate.id != original.id
    assert body["archive_id"] is None and body["library_file_id"] is None and body["printer_id"] is None
    assert body["target_model"] == originals[0].target_model
    assert body["chamber_heat_soak"] is True and body["force_color_match"] is False
    assert body["position"] < (-20 if missing == "alternative" else -30)
    new = await db_session.get(PrintQueueItem, body["id"])
    assert new.print_time_seconds == min(v.print_time_seconds for v in originals)
    await db_session.refresh(old)
    assert old.status == "failed" and old.printer_id == printer.id


@pytest.mark.parametrize("auth_method", ["jwt", "api_key"])
@pytest.mark.parametrize("can_insert_top", [False, True])
async def test_retry_requires_insert_top_permission(
    async_client, db_session, printer_factory, tmp_path, auth_method, can_insert_top
):
    setup = await async_client.post(
        "/api/v1/auth/setup",
        json={
            "auth_enabled": True,
            "admin_username": "retryadmin",
            "admin_password": "Adminpass1!",
        },
    )
    assert setup.status_code == 200, setup.text
    login = await async_client.post("/api/v1/auth/login", json={"username": "retryadmin", "password": "Adminpass1!"})
    admin_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    permissions = ["queue:create", "queue:update_own", "queue:read_own", "library:read_all", "printers:read"]
    if can_insert_top:
        permissions.append("queue:insert_top")
    group = await async_client.post(
        "/api/v1/groups/",
        headers=admin_headers,
        json={
            "name": "Retry operator",
            "permissions": permissions,
        },
    )
    assert group.status_code in (200, 201), group.text
    user = await async_client.post(
        "/api/v1/users/",
        headers=admin_headers,
        json={
            "username": "retryoperator",
            "password": "Operatorpass1!",
            "group_ids": [group.json()["id"]],
        },
    )
    assert user.status_code in (200, 201), user.text
    owner_id = user.json()["id"]
    if auth_method == "api_key":
        from backend.app.core.auth import generate_api_key
        from backend.app.models.api_key import APIKey

        key, key_hash, key_prefix = generate_api_key()
        db_session.add(
            APIKey(name="retry key", key_hash=key_hash, key_prefix=key_prefix, user_id=owner_id, can_queue=True)
        )
        await db_session.commit()
        headers = {"X-API-Key": key}
    else:
        login = await async_client.post(
            "/api/v1/auth/login",
            json={
                "username": "retryoperator",
                "password": "Operatorpass1!",
            },
        )
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    printer = await printer_factory()
    source = await _source(db_session, tmp_path / "source.3mf", "X1C")
    old = PrintQueueItem(printer_id=printer.id, library_file_id=source.id, status="failed", created_by_id=owner_id)
    db_session.add_all([old, PrintQueueItem(assigned_printer_id=printer.id, status="queued", position=10)])
    await db_session.commit()
    if not can_insert_top:
        admission = await async_client.post(
            "/api/v1/queue/",
            headers=headers,
            json={
                "printer_id": printer.id,
                "library_file_id": source.id,
                "insert_at_top": True,
            },
        )
        assert admission.status_code == 403
    response = await async_client.post(f"/api/v1/queue/{old.id}/retry", headers=headers)
    assert response.status_code == (200 if can_insert_top else 403), response.text
    if can_insert_top:
        assert response.json()["position"] < 10
        assert response.json()["created_by_id"] == owner_id
    else:
        assert await db_session.scalar(select(func.count(PrintQueueItem.id))) == 2
    await db_session.refresh(old)
    assert old.status == "failed"
