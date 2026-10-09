"""Fixtures for lifecycle scenarios."""

import logging

import pytest

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
