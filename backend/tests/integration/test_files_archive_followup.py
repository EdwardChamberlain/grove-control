"""Regression coverage for the Files/Archive follow-up fixes on PR #189."""

from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.pending_upload import PendingUpload
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.queue_source_cleanup import remove_queue_only_source_if_unused, sweep_stale_queue_sources


def _configure_storage(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    """Keep upload and Archive artifacts inside per-test temporary directories."""
    base_dir = tmp_path / "data"
    archive_dir = tmp_path / "mounted-archives"
    base_dir.mkdir()
    archive_dir.mkdir()
    monkeypatch.setattr(settings, "base_dir", base_dir)
    monkeypatch.setattr(settings, "archive_dir", archive_dir)
    return base_dir, archive_dir


def _three_mf_bytes() -> bytes:
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", "; test gcode\n")
    return stream.getvalue()


async def _add_pending_upload(db: AsyncSession, path: Path, *, filename: str, tags: str | None = None) -> int:
    payload = _three_mf_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    pending = PendingUpload(
        filename=filename,
        file_path=str(path),
        file_size=len(payload),
        source_ip="192.168.1.50",
        status="pending",
        tags=tags,
    )
    db.add(pending)
    await db.commit()
    await db.refresh(pending)
    return pending.id


class TestPendingUploadSaveToFiles:
    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("tags", [None, "Prototype, PLA"])
    async def test_save_one_pending_upload_loads_tags_without_duplicates(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch,
        tmp_path: Path,
        tags: str | None,
    ):
        _configure_storage(monkeypatch, tmp_path)
        upload_id = await _add_pending_upload(
            db_session,
            tmp_path / "pending" / "single.3mf",
            filename="single.3mf",
        )

        response = await async_client.post(
            f"/api/v1/pending-uploads/{upload_id}/save-to-files",
            json={"tags": tags},
        )

        assert response.status_code == 200, response.text
        saved_id = response.json()["library_file_id"]
        saved_result = await db_session.execute(
            select(LibraryFile).options(selectinload(LibraryFile.tags)).where(LibraryFile.id == saved_id)
        )
        saved = saved_result.scalar_one_or_none()
        assert saved is not None
        assert saved.queue_only is False
        assert {tag.name for tag in saved.tags} == (set() if tags is None else {"Prototype", "PLA"})
        assert await db_session.scalar(select(func.count(LibraryFile.id))) == 1
        pending = await db_session.get(PendingUpload, upload_id)
        assert pending is not None
        await db_session.refresh(pending)
        assert pending is not None and pending.status == "saved_to_files"

        # A retry cannot create another File because the pending row is terminal.
        retry = await async_client.post(f"/api/v1/pending-uploads/{upload_id}/save-to-files")
        assert retry.status_code == 400
        assert await db_session.scalar(select(func.count(LibraryFile.id))) == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_save_all_pending_uploads_saves_each_once(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch,
        tmp_path: Path,
    ):
        _configure_storage(monkeypatch, tmp_path)
        await _add_pending_upload(
            db_session,
            tmp_path / "pending" / "plain.3mf",
            filename="plain.3mf",
        )
        await _add_pending_upload(
            db_session,
            tmp_path / "pending" / "tagged.3mf",
            filename="tagged.3mf",
            tags="Queue, Review",
        )

        response = await async_client.post("/api/v1/pending-uploads/save-to-files-all")
        assert response.status_code == 200, response.text
        assert response.json() == {"saved": 2, "failed": 0}
        assert await db_session.scalar(select(func.count(LibraryFile.id))) == 2

        retry = await async_client.post("/api/v1/pending-uploads/save-to-files-all")
        assert retry.status_code == 200
        assert retry.json() == {"saved": 0, "failed": 0}
        assert await db_session.scalar(select(func.count(LibraryFile.id))) == 2


class TestArchiveSaveToFilesPaths:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_save_accepts_absolute_artifact_under_external_archive_dir(
        self,
        async_client: AsyncClient,
        archive_factory,
        printer_factory,
        db_session: AsyncSession,
        monkeypatch,
        tmp_path: Path,
    ):
        base_dir, archive_dir = _configure_storage(monkeypatch, tmp_path)
        artifact = archive_dir / "legacy" / "print.3mf"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(_three_mf_bytes())
        printer = await printer_factory()
        archive = await archive_factory(printer.id, filename="print.3mf", file_path=str(artifact))

        response = await async_client.post(f"/api/v1/archives/{archive.id}/save-to-files")

        assert response.status_code == 201, response.text
        saved = await db_session.get(LibraryFile, response.json()["library_file_id"])
        assert saved is not None
        assert (base_dir / saved.file_path).is_file()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_save_rejects_absolute_artifact_outside_archive_dir(
        self,
        async_client: AsyncClient,
        archive_factory,
        printer_factory,
        monkeypatch,
        tmp_path: Path,
    ):
        _configure_storage(monkeypatch, tmp_path)
        outside = tmp_path / "outside.3mf"
        outside.write_bytes(_three_mf_bytes())
        printer = await printer_factory()
        archive = await archive_factory(printer.id, filename="outside.3mf", file_path=str(outside))

        response = await async_client.post(f"/api/v1/archives/{archive.id}/save-to-files")

        assert response.status_code == 404
        assert response.json()["detail"] == "Archive artifact path is invalid"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_save_rejects_malformed_relative_artifact_with_not_found(
        self,
        async_client: AsyncClient,
        archive_factory,
        printer_factory,
        monkeypatch,
        tmp_path: Path,
    ):
        _configure_storage(monkeypatch, tmp_path)
        printer = await printer_factory()
        archive = await archive_factory(printer.id, filename="invalid.3mf", file_path="../outside.3mf")

        response = await async_client.post(f"/api/v1/archives/{archive.id}/save-to-files")

        assert response.status_code == 404
        assert response.json()["detail"] == "Archive artifact path is invalid"


class TestQueueUploadSourceLifecycle:
    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("keep_for_active_item", [False, True])
    async def test_stale_source_sweep_seals_abandoned_uploads_and_preserves_active_items(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        printer_factory,
        monkeypatch,
        tmp_path: Path,
        keep_for_active_item: bool,
    ):
        _configure_storage(monkeypatch, tmp_path)
        response = await async_client.post(
            "/api/v1/queue/upload-source",
            files={"file": ("abandoned.gcode.3mf", _three_mf_bytes(), "application/octet-stream")},
        )
        assert response.status_code == 200, response.text
        library_file_id = response.json()["id"]
        source = await db_session.get(LibraryFile, library_file_id)
        assert source is not None
        source_path = Path(settings.base_dir) / source.file_path
        assert source_path.is_file()

        if keep_for_active_item:
            printer = await printer_factory()
            pending_item = PrintQueueItem(
                printer_id=printer.id,
                library_file_id=library_file_id,
                position=1,
                status="pending",
                cleanup_library_after_dispatch=True,
            )
            db_session.add(pending_item)

        source.created_at = datetime.now(timezone.utc) - timedelta(hours=25)
        await db_session.commit()

        sealed_count = await sweep_stale_queue_sources(db_session)

        assert sealed_count == 1
        source = await db_session.get(LibraryFile, library_file_id)
        if keep_for_active_item:
            assert source is not None and source.queue_source_sealed is True
            assert source_path.is_file()
            assert pending_item.library_file_id == library_file_id

            late_item = await async_client.post(
                "/api/v1/queue/",
                json={"printer_id": pending_item.printer_id, "library_file_id": library_file_id},
            )
            assert late_item.status_code == 400
            assert late_item.json()["detail"] == "Queue upload source is no longer accepting queue items"

            cancelled = await async_client.post(f"/api/v1/queue/{pending_item.id}/cancel")
            assert cancelled.status_code == 200, cancelled.text

        assert await db_session.get(LibraryFile, library_file_id) is None
        assert not source_path.exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize("terminal_action", ["cancel", "delete"])
    async def test_source_stays_hidden_until_submission_closes_then_cleans_up(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        printer_factory,
        monkeypatch,
        tmp_path: Path,
        terminal_action: str,
    ):
        _configure_storage(monkeypatch, tmp_path)
        response = await async_client.post(
            "/api/v1/queue/upload-source",
            files={"file": ("fanout.gcode.3mf", _three_mf_bytes(), "application/octet-stream")},
        )
        assert response.status_code == 200, response.text
        library_file_id = response.json()["id"]
        source = await db_session.get(LibraryFile, library_file_id)
        assert source is not None and source.queue_only is True and source.queue_source_sealed is False
        source_path = Path(settings.base_dir) / source.file_path
        assert source_path.is_file()

        listing = await async_client.get("/api/v1/library/files")
        assert listing.status_code == 200
        assert library_file_id not in {row["id"] for row in listing.json()}

        printer = await printer_factory()
        first_item = PrintQueueItem(
            printer_id=printer.id,
            library_file_id=library_file_id,
            position=1,
            status="dispatching",
            cleanup_library_after_dispatch=True,
        )
        db_session.add(first_item)
        await db_session.commit()
        await db_session.refresh(first_item)

        # The scheduler has copied this item's bytes into its Archive, so it
        # detaches the source before the remaining fan-out POSTs arrive.
        first_item.library_file_id = None
        await db_session.commit()
        premature_cleanup = await remove_queue_only_source_if_unused(
            db_session,
            library_file_id,
            exclude_item_id=first_item.id,
        )
        assert premature_cleanup == []
        assert source_path.is_file()

        # A later fan-out request can still link the same source after the
        # first item has already dispatched.
        later_item = PrintQueueItem(
            printer_id=printer.id,
            library_file_id=library_file_id,
            position=2,
            status="pending",
            cleanup_library_after_dispatch=True,
        )
        db_session.add(later_item)
        await db_session.commit()
        await db_session.refresh(later_item)

        # Closing intake seals the source but must retain it while any posted
        # fan-out item still needs its bytes.
        close_response = await async_client.delete(f"/api/v1/queue/upload-source/{library_file_id}")
        assert close_response.status_code == 200
        await db_session.refresh(source)
        assert source.queue_source_sealed is True
        assert source_path.is_file()

        if terminal_action == "cancel":
            terminal = await async_client.post(f"/api/v1/queue/{later_item.id}/cancel")
        else:
            terminal = await async_client.delete(f"/api/v1/queue/{later_item.id}")
        assert terminal.status_code == 200
        assert await db_session.scalar(select(func.count(LibraryFile.id)).where(LibraryFile.id == library_file_id)) == 0
        assert not source_path.exists()


class TestDispatchArchiveLifecycle:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stopping_dispatch_marks_its_attempt_archive_aborted(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        archive_factory,
        printer_factory,
        monkeypatch,
    ):
        from backend.app.services.printer_manager import printer_manager

        printer = await printer_factory()
        archive = await archive_factory(printer.id, status="dispatching")
        item = PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            position=1,
            status="dispatching",
        )
        db_session.add(item)
        await db_session.commit()
        await db_session.refresh(item)
        archive.extra_data = {"source": "queue_dispatch", "queue_item_id": item.id}
        await db_session.commit()

        monkeypatch.setattr(printer_manager, "stop_print", lambda _printer_id: False)
        response = await async_client.post(f"/api/v1/queue/{item.id}/stop")

        assert response.status_code == 200, response.text
        await db_session.refresh(archive)
        assert archive.status == "aborted"
        assert archive.completed_at is not None
