#!/usr/bin/env python3
"""Validate package metadata against the root VERSION file."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parent.parent
STABLE_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def read_version() -> str:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not version:
        raise ValueError("VERSION is empty")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:b\d+)?", version):
        raise ValueError("VERSION must look like 0.1.0 or 0.1.0b1")
    return version


def check(label: str, actual: str, expected: str) -> bool:
    if actual == expected:
        print(f"OK {label}: {actual}")
        return True
    print(f"FAIL {label}: expected {expected}, found {actual}", file=sys.stderr)
    return False


def check_missing(label: str, data: dict[str, object], key: str) -> bool:
    if key not in data:
        print(f"OK {label}: no duplicated {key}")
        return True
    print(f"FAIL {label}: remove duplicated {key}; use VERSION instead", file=sys.stderr)
    return False


def parse_stable_version(value: str, label: str) -> tuple[int, int, int]:
    """Parse a stable X.Y.Z version for release ordering checks."""
    normalized = value.strip()
    match = STABLE_VERSION_RE.fullmatch(normalized)
    if not match:
        raise ValueError(f"{label} must be a stable X.Y.Z version; got: {normalized!r}")
    return tuple(int(part) for part in match.groups())


def check_release_version(candidate_version: str, previous_version: str) -> bool:
    """Require a stable candidate version greater than the previous release."""
    try:
        candidate = parse_stable_version(candidate_version, "VERSION")
        previous = parse_stable_version(previous_version, "base VERSION")
    except ValueError as exc:
        print(f"FAIL release version: {exc}", file=sys.stderr)
        return False

    if candidate <= previous:
        print(
            "FAIL release version: "
            f"VERSION {candidate_version.strip()} must be greater than base VERSION {previous_version.strip()}",
            file=sys.stderr,
        )
        return False

    print(f"OK release version: {candidate_version.strip()} > {previous_version.strip()}")
    return True


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--previous-version",
        help="also require VERSION to be a greater stable version than this base version",
    )
    args = parser.parse_args(argv)

    expected = read_version()
    print(f"OK VERSION: {expected}")
    ok = True

    if args.previous_version is not None:
        ok &= check_release_version(expected, args.previous_version)

    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = pyproject["project"]
    ok &= check_missing("pyproject.toml [project]", project, "version")
    ok &= check("pyproject.toml project.dynamic", "version" in project.get("dynamic", []), True)
    dynamic_version = pyproject.get("tool", {}).get("setuptools", {}).get("dynamic", {}).get("version", {})
    ok &= check("pyproject.toml dynamic version file", dynamic_version.get("file"), ["VERSION"])

    package_json = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    ok &= check_missing("frontend/package.json", package_json, "version")

    package_lock = json.loads((ROOT / "frontend/package-lock.json").read_text(encoding="utf-8"))
    ok &= check_missing("frontend/package-lock.json", package_lock, "version")
    ok &= check_missing("frontend/package-lock.json root package", package_lock["packages"][""], "version")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
