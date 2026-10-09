"""Fixtures for lifecycle scenarios."""

import logging
import os
from uuid import uuid4

import asyncpg
import pytest
from sqlalchemy.engine import make_url

from backend.tests.scenarios.harness import Harness


class _Errors(logging.Handler):
    def __init__(self):
        super().__init__(logging.ERROR)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
async def app(tmp_path, monkeypatch):
    """The app with no printers yet. Any error it logs fails the scenario."""
    errors = _Errors()
    logging.getLogger().addHandler(errors)
    harness = Harness(tmp_path, monkeypatch)
    await harness.start()
    try:
        yield harness
    finally:
        await harness.stop()
        logging.getLogger().removeHandler(errors)
    from backend.app.services.lifecycle import engine

    violations = list(dict.fromkeys(engine.violations or []))
    assert not violations, "one-writer violations:\n" + "\n".join(violations)
    unexpected = [r for r in errors.records if not any(allowed in r.getMessage() for allowed in harness.allowed_errors)]
    assert not unexpected, "the app logged errors:\n" + "\n".join(
        f"{r.name}: {r.getMessage()}" + (f"\n{r.exc_text or ''}" if r.exc_info else "") for r in unexpected
    )


@pytest.fixture
async def postgres_app(tmp_path, monkeypatch):
    """A scenario app in a fresh PostgreSQL database created from the configured test server."""
    raw_url = os.environ.get("LIFECYCLE_POSTGRES_TEST_URL")
    if not raw_url:
        pytest.fail("LIFECYCLE_POSTGRES_TEST_URL is required for PostgreSQL lifecycle regressions")
    url = make_url(raw_url)
    if url.get_backend_name() != "postgresql":
        pytest.fail("LIFECYCLE_POSTGRES_TEST_URL must select PostgreSQL")

    database_name = f"grove_lifecycle_{uuid4().hex}"
    admin_url = url.set(drivername="postgresql", database="postgres").render_as_string(hide_password=False)
    connection = await asyncpg.connect(admin_url)
    await connection.execute(f'CREATE DATABASE "{database_name}"')
    await connection.close()

    app_url = url.set(database=database_name).render_as_string(hide_password=False)
    harness = Harness(tmp_path, monkeypatch, database_url=app_url)
    errors = _Errors()
    logging.getLogger().addHandler(errors)
    started = False
    try:
        await harness.start()
        started = True
        yield harness
    finally:
        try:
            if started:
                await harness.stop()
                from backend.app.services.lifecycle import engine

                violations = list(dict.fromkeys(engine.violations or []))
                assert not violations, "one-writer violations:\n" + "\n".join(violations)
                unexpected = [
                    record
                    for record in errors.records
                    if not any(allowed in record.getMessage() for allowed in harness.allowed_errors)
                ]
                assert not unexpected, "the app logged errors:\n" + "\n".join(
                    f"{record.name}: {record.getMessage()}" for record in unexpected
                )
        finally:
            logging.getLogger().removeHandler(errors)
            connection = await asyncpg.connect(admin_url)
            await connection.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
                database_name,
            )
            await connection.execute(f'DROP DATABASE IF EXISTS "{database_name}"')
            await connection.close()
