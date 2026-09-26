"""API routes for pending uploads (virtual printer queue mode)."""

from datetime import datetime
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import RequirePermissionIfAuthEnabled, require_ownership_permission, resolve_api_key_owner
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFile, LibraryTag
from backend.app.models.pending_upload import PendingUpload
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.services.archive import resolve_display_stem

router = APIRouter(prefix="/pending-uploads", tags=["pending-uploads"])


class SaveToFilesRequest(BaseModel):
    """Optional File Manager details for a pending upload."""

    tags: str | None = None
    notes: str | None = None
    project_id: int | None = None


class PendingUploadResponse(BaseModel):
    """Response model for pending upload."""

    id: int
    filename: str
    display_name: str
    file_size: int
    source_ip: str | None
    status: str
    tags: str | None
    notes: str | None
    project_id: int | None
    uploaded_at: datetime

    class Config:
        from_attributes = True


def _resolve_display_name(pending: PendingUpload, prefer_filename: bool) -> str:
    """Compute the name the review card should show.

    Mirrors the virtual-printer display-name setting:
      - ``prefer_filename=True`` → stripped filename stem.
      - ``prefer_filename=False`` → ``metadata_print_name`` if set, else stem.
    """
    stem = resolve_display_stem(pending.filename)
    if prefer_filename:
        return stem
    return (pending.metadata_print_name or "").strip() or stem


async def _augment_with_display_name(
    db: AsyncSession,
    pendings: list[PendingUpload],
) -> list[PendingUploadResponse]:
    """Build response objects with display_name resolved against the toggle.

    Reads the ``virtual_printer_archive_name_source`` setting once per request
    rather than per row.
    """
    from backend.app.api.routes.settings import get_setting

    prefer_filename = (await get_setting(db, "virtual_printer_archive_name_source")) == "filename"
    return [
        PendingUploadResponse(
            id=p.id,
            filename=p.filename,
            display_name=_resolve_display_name(p, prefer_filename),
            file_size=p.file_size,
            source_ip=p.source_ip,
            status=p.status,
            tags=p.tags,
            notes=p.notes,
            project_id=p.project_id,
            uploaded_at=p.uploaded_at,
        )
        for p in pendings
    ]


@router.get("/", response_model=list[PendingUploadResponse])
async def list_pending_uploads(
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_READ_ALL,
            Permission.QUEUE_READ_OWN,
        )
    ),
):
    """List all pending uploads."""
    result = await db.execute(
        select(PendingUpload).where(PendingUpload.status == "pending").order_by(PendingUpload.uploaded_at.desc())
    )

    return await _augment_with_display_name(db, list(result.scalars().all()))


@router.get("/count")
async def get_pending_count(
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_READ_ALL,
            Permission.QUEUE_READ_OWN,
        )
    ),
):
    """Get count of pending uploads."""
    result = await db.execute(select(PendingUpload).where(PendingUpload.status == "pending"))
    count = len(result.scalars().all())

    return {"count": count}


# Note: Bulk operations must be defined BEFORE parameterized routes.


async def _save_pending_to_files(
    db: AsyncSession,
    pending: PendingUpload,
    request: SaveToFilesRequest | None,
    current_user: User | None,
    api_key_owner: User | None,
) -> LibraryFile:
    """Copy a virtual-printer upload into Files and mark it processed."""
    file_path = Path(pending.file_path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Upload file not found on disk")

    project_id = request.project_id if request and request.project_id is not None else pending.project_id
    if project_id is not None:
        project = await db.get(Project, project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")

    raw_tags = request.tags if request and request.tags is not None else pending.tags
    tag_names = list(dict.fromkeys(name.strip() for name in (raw_tags or "").split(",") if name.strip()))
    if any(len(name) > 64 for name in tag_names):
        raise HTTPException(status_code=400, detail="File tags must be 64 characters or fewer")

    notes = request.notes if request and request.notes is not None else pending.notes

    # Reuse the regular File Manager upload validation, metadata parsing, and
    # thumbnail handling. Directly uploaded queue files remain ordinary Files.
    from backend.app.api.routes.library import upload_file

    upload = UploadFile(file=BytesIO(file_path.read_bytes()), filename=pending.filename)
    response = await upload_file(
        file=upload,
        folder_id=None,
        generate_stl_thumbnails=True,
        db=db,
        current_user=current_user,
        api_key_owner=api_key_owner,
    )
    library_file_result = await db.execute(
        select(LibraryFile).options(selectinload(LibraryFile.tags)).where(LibraryFile.id == response.id)
    )
    library_file = library_file_result.scalar_one_or_none()
    if library_file is None:
        raise HTTPException(status_code=500, detail="Saved File could not be loaded")

    library_file.project_id = project_id
    library_file.notes = notes
    library_file.tags = []
    for name in tag_names:
        name_key = name.strip().lower()
        result = await db.execute(select(LibraryTag).where(LibraryTag.name_key == name_key))
        tag = result.scalar_one_or_none()
        if tag is None:
            tag = LibraryTag(name=name, name_key=name_key)
            db.add(tag)
            await db.flush()
        library_file.tags.append(tag)

    pending.tags = ", ".join(tag_names) or None
    pending.notes = notes
    pending.project_id = project_id
    pending.status = "saved_to_files"
    await db.commit()

    try:
        file_path.unlink(missing_ok=True)
    except OSError:
        pass  # Best-effort cleanup after the File Manager copy is committed.

    return library_file


@router.post("/save-to-files-all")
async def save_all_pending_to_files(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.LIBRARY_UPLOAD),
    api_key_owner: User | None = Depends(resolve_api_key_owner),
):
    """Save all pending uploads to Files."""
    result = await db.execute(select(PendingUpload).where(PendingUpload.status == "pending"))
    pending_uploads = result.scalars().all()

    saved = 0
    failed = 0

    for pending in pending_uploads:
        try:
            await _save_pending_to_files(db, pending, None, current_user, api_key_owner)
            saved += 1
        except HTTPException:
            failed += 1
            if not Path(pending.file_path).exists():
                pending.status = "discarded"
        except Exception:
            failed += 1
            await db.rollback()

    await db.commit()

    return {"saved": saved, "failed": failed}


@router.post("/archive-all")
async def archive_all_pending(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ARCHIVES_CREATE),
):
    """Removed: pending uploads can be saved to Files, not Archive."""
    raise HTTPException(status_code=410, detail="Save pending uploads to Files instead")


@router.delete("/discard-all")
async def discard_all_pending(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_DELETE_ALL),
):
    """Discard all pending uploads."""
    result = await db.execute(select(PendingUpload).where(PendingUpload.status == "pending"))
    pending_uploads = result.scalars().all()

    discarded = 0

    for pending in pending_uploads:
        # Delete file from disk
        try:
            file_path = Path(pending.file_path)
            file_path.unlink(missing_ok=True)
        except OSError:
            pass  # Best-effort file deletion; record is still marked discarded

        pending.status = "discarded"
        discarded += 1

    await db.commit()

    return {"discarded": discarded}


@router.get("/{upload_id}", response_model=PendingUploadResponse)
async def get_pending_upload(
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    _: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.QUEUE_READ_ALL,
            Permission.QUEUE_READ_OWN,
        )
    ),
):
    """Get a specific pending upload."""
    result = await db.execute(select(PendingUpload).where(PendingUpload.id == upload_id))
    pending = result.scalar_one_or_none()

    if not pending:
        raise HTTPException(status_code=404, detail="Upload not found")

    return (await _augment_with_display_name(db, [pending]))[0]


@router.post("/{upload_id}/save-to-files")
async def save_pending_to_files(
    upload_id: int,
    request: SaveToFilesRequest | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.LIBRARY_UPLOAD),
    api_key_owner: User | None = Depends(resolve_api_key_owner),
):
    """Save one pending upload to Files."""
    result = await db.execute(select(PendingUpload).where(PendingUpload.id == upload_id))
    pending = result.scalar_one_or_none()

    if not pending:
        raise HTTPException(status_code=404, detail="Upload not found")
    if pending.status != "pending":
        raise HTTPException(status_code=400, detail="Upload already processed")

    library_file = await _save_pending_to_files(db, pending, request, current_user, api_key_owner)
    return {"library_file_id": library_file.id, "filename": library_file.filename}


@router.post("/{upload_id}/archive")
async def archive_pending_upload(
    upload_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ARCHIVES_CREATE),
):
    """Removed: pending uploads can be saved to Files, not Archive."""
    raise HTTPException(status_code=410, detail="Save pending uploads to Files instead")


@router.delete("/{upload_id}")
async def discard_pending_upload(
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_DELETE_ALL),
):
    """Discard a pending upload without saving it."""
    result = await db.execute(select(PendingUpload).where(PendingUpload.id == upload_id))
    pending = result.scalar_one_or_none()

    if not pending:
        raise HTTPException(status_code=404, detail="Upload not found")

    # Delete file from disk
    file_path = Path(pending.file_path)
    try:
        file_path.unlink(missing_ok=True)
    except OSError:
        pass  # Best-effort file deletion on discard

    pending.status = "discarded"
    await db.commit()

    return {"success": True}
