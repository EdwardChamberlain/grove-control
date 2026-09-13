"""Tests for repository version validation helpers."""

from scripts.check_version import check_release_version


def test_check_release_version_accepts_higher_patch_version():
    assert check_release_version("1.0.1", "1.0.0") is True


def test_check_release_version_accepts_major_and_minor_jumps():
    assert check_release_version("2.0.0", "1.9.9") is True
    assert check_release_version("1.3.0", "1.2.9") is True


def test_check_release_version_rejects_unchanged_or_lower_versions():
    assert check_release_version("1.0.0", "1.0.0") is False
    assert check_release_version("0.9.9", "1.0.0") is False


def test_check_release_version_rejects_prerelease_or_malformed_versions():
    assert check_release_version("1.0.0b1", "0.9.9") is False
    assert check_release_version("1.0", "0.9.9") is False
    assert check_release_version("01.0.0", "0.9.9") is False
