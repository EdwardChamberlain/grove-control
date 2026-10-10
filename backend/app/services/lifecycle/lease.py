"""One Grove process per database.

The lifecycle keeps each printer's writer in process memory (``engine.writer``),
so two processes on one database would each believe they were the only
writer. Startup takes this lease and refuses to run without it. SQLite uses a
lock file beside the database; PostgreSQL a session advisory lock on a
connection held for the life of the process. Both are released by the
operating system or the server if the process dies.
"""

import logging
import os
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

logger = logging.getLogger(__name__)

_ADVISORY_KEY = 0x47524F56  # "GROV"


class LeaseHeld(RuntimeError):
    """Another Grove process is already running on this database."""


class Lease:
    def __init__(self) -> None:
        self._file = None
        self._connection: AsyncConnection | None = None

    async def acquire(self, engine: AsyncEngine) -> None:
        url = make_url(str(engine.url))
        if url.get_backend_name() == "sqlite":
            self._lock_file(Path(url.database or "grove.db"))
        else:
            await self._advisory_lock(engine)

    def _lock_file(self, database: Path) -> None:
        path = database.with_name(database.name + ".lock")
        handle = open(path, "a+")  # noqa: SIM115 - held open for the life of the process
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            raise LeaseHeld(f"Another Grove process is using {database}; stop it before starting this one") from error
        self._file = handle

    async def _advisory_lock(self, engine: AsyncEngine) -> None:
        connection = await engine.connect()
        locked = await connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": _ADVISORY_KEY})
        if not locked:
            await connection.close()
            raise LeaseHeld("Another Grove process is using this database; stop it before starting this one")
        await connection.commit()
        self._connection = connection

    async def release(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None
        if self._connection is not None:
            await self._connection.close()
            self._connection = None


lease = Lease()
