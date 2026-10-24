"""Archive only records prints; there is no way to upload a file into it (#232)."""

import io
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.api.routes.archives import router as archives_router
from backend.app.models.archive import PrintArchive

# Every POST route on the Archive router. None may create a new Archive entry:
# each acts on an existing entry or on all of them. Adding a route here is a
# deliberate decision that it does not let users put files into Archive.
EXPECTED_POST_ROUTES = {
    "/archives/backfill-hashes",
    "/archives/recalculate-costs",
    "/archives/rescan-all",
    "/archives/search/rebuild-index",
    "/archives/upload-source",  # attaches to the matching existing entry
    "/archives/{archive_id}/f3d",
    "/archives/{archive_id}/favorite",
    "/archives/{archive_id}/photos",
    "/archives/{archive_id}/rescan",
    "/archives/{archive_id}/save-to-files",
    "/archives/{archive_id}/slice",
    "/archives/{archive_id}/slicer-token",
    "/archives/{archive_id}/source",
    "/archives/{archive_id}/source-slicer-token",
    "/archives/{archive_id}/timelapse/process",
    "/archives/{archive_id}/timelapse/scan",
    "/archives/{archive_id}/timelapse/select",
    "/archives/{archive_id}/timelapse/upload",
}


def _minimal_3mf() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
    return buf.getvalue()


class TestArchiveUploadRemoved:
    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        "path,field",
        [("/api/v1/archives/upload", "file"), ("/api/v1/archives/upload-bulk", "files")],
    )
    async def test_upload_routes_do_not_create_archives(self, async_client: AsyncClient, db_session, path, field):
        files = [(field, ("model.3mf", _minimal_3mf(), "application/zip"))]
        response = await async_client.post(path, files=files)

        assert response.status_code in (404, 405)
        count = (await db_session.execute(select(func.count()).select_from(PrintArchive))).scalar_one()
        assert count == 0


def test_archive_post_routes_are_the_reviewed_set():
    actual = {r.path for r in archives_router.routes if "POST" in getattr(r, "methods", set())}
    assert actual == EXPECTED_POST_ROUTES
