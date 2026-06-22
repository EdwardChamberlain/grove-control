"""
Read /etc/bambuddy/local.toml — the file the appliance setup wizard writes
during firstboot to capture the user's hostname, timezone, and locale.

Universal across install shapes:

- On the Bambuddy Appliance: the wizard writes this file before bambuddy.service
  starts; we read it on every startup to surface defaults to the frontend.
- On Docker / manual installs: the file is absent; we degrade silently. An
  operator who wants to seed defaults can drop their own local.toml into the
  expected path or override via DATA_DIR.

The reader is read-only and side-effect-free. It does NOT call hostnamectl
or timedatectl — that's the appliance's firstboot.sh responsibility (it has
the root privileges to do so and runs before this process exists). What we
do here is expose the values the wizard collected so the frontend i18n
bootstrap can pick the right initial language.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TypedDict

import tomllib

log = logging.getLogger(__name__)

DEFAULT_PATH = Path("/etc/bambuddy/local.toml")


class LocalConfig(TypedDict, total=False):
    hostname: str
    timezone: str
    locale: str


def read_local_toml(path: Path = DEFAULT_PATH) -> LocalConfig:
    """Read the appliance local.toml. Missing / invalid file returns empty dict.

    Only the keys actually present in the file are returned — the caller checks
    `if "locale" in config:` rather than relying on defaults. Non-string values
    are dropped with a warning to keep this defensive on a hand-edited file.
    """
    if not path.is_file():
        return {}
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        log.warning("local.toml at %s could not be parsed: %s", path, exc)
        return {}

    result: LocalConfig = {}
    for key in ("hostname", "timezone", "locale"):
        value = data.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            log.warning("local.toml: %r is %s, expected str — ignoring", key, type(value).__name__)
            continue
        result[key] = value  # type: ignore[literal-required]
    return result
