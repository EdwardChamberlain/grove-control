"""Archive only records prints; there is no way to upload a file into it (#232)."""

import io
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive


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
