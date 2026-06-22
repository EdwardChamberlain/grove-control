#!/usr/bin/env python3
"""Validate package metadata against the root VERSION file."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parent.parent


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


def main() -> int:
    expected = read_version()
    print(f"OK VERSION: {expected}")
    ok = True

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
