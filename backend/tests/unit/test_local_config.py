"""
Tests for backend.app.core.local_config — the reader for
/etc/bambuddy/local.toml that the appliance setup wizard writes.

Defensive on bad input: every failure mode returns an empty dict
(never raises), so a malformed file never blocks startup.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.core.local_config import read_local_toml


def test_missing_file_returns_empty(tmp_path: Path):
    assert read_local_toml(tmp_path / "nope.toml") == {}


def test_empty_file_returns_empty(tmp_path: Path):
    path = tmp_path / "local.toml"
    path.write_text("")
    assert read_local_toml(path) == {}


def test_comment_only_file_returns_empty(tmp_path: Path):
    path = tmp_path / "local.toml"
    path.write_text("# Written by bambuddy-wizard during firstboot.\n")
    assert read_local_toml(path) == {}


def test_full_config_parses(tmp_path: Path):
    path = tmp_path / "local.toml"
    path.write_text(
        "# Written by bambuddy-wizard during firstboot.\n"
        'hostname = "workshop-pi"\n'
        'timezone = "Europe/Berlin"\n'
        'locale = "de"\n'
    )
    result = read_local_toml(path)
    assert result == {
        "hostname": "workshop-pi",
        "timezone": "Europe/Berlin",
        "locale": "de",
    }


def test_partial_config_only_returns_present_keys(tmp_path: Path):
    path = tmp_path / "local.toml"
    path.write_text('locale = "ja"\n')
    result = read_local_toml(path)
    assert result == {"locale": "ja"}
    assert "hostname" not in result
    assert "timezone" not in result


def test_invalid_toml_returns_empty(tmp_path: Path, caplog: pytest.LogCaptureFixture):
    path = tmp_path / "local.toml"
    path.write_text("not = valid = toml = at all\n")
    result = read_local_toml(path)
    assert result == {}
    assert any("could not be parsed" in r.message for r in caplog.records)


def test_non_string_value_is_dropped(tmp_path: Path, caplog: pytest.LogCaptureFixture):
    path = tmp_path / "local.toml"
    path.write_text(
        "hostname = 42\n"  # not a string
        'locale = "de"\n'
    )
    result = read_local_toml(path)
    assert result == {"locale": "de"}
    assert any("expected str" in r.message for r in caplog.records)


def test_unknown_keys_are_ignored(tmp_path: Path):
    """A hand-edited config with extra keys must not leak them to the response."""
    path = tmp_path / "local.toml"
    path.write_text('locale = "de"\nunknown_key = "value"\nadmin_password = "should not surface"\n')
    result = read_local_toml(path)
    assert set(result.keys()) <= {"hostname", "timezone", "locale"}
    assert "admin_password" not in result


def test_escaped_characters_round_trip(tmp_path: Path):
    """The wizard escapes backslash and quote when writing; the reader parses them back."""
    path = tmp_path / "local.toml"
    path.write_text('hostname = "with\\"quote"\n')
    result = read_local_toml(path)
    assert result == {"hostname": 'with"quote'}
