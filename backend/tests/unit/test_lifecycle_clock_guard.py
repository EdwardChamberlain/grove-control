"""Lifecycle code reads time only through ``lifecycle.clock``, so scenarios can control it."""

import re
from pathlib import Path

LIFECYCLE = Path(__file__).resolve().parents[2] / "app" / "services" / "lifecycle"
DIRECT = re.compile(r"datetime\.now\(|datetime\.utcnow\(|time\.time\(|time\.monotonic\(|asyncio\.sleep\(|loop\.time\(")

# Files still allowed a direct call, and why. Keep it empty.
ALLOWED: dict[str, str] = {}


def test_lifecycle_code_reads_time_only_through_the_clock():
    offenders = {}
    for path in sorted(LIFECYCLE.glob("*.py")):
        if " 2" in path.name or path.name == "clock.py":
            continue
        hits = [n for n, line in enumerate(path.read_text().splitlines(), 1) if DIRECT.search(line)]
        if hits:
            offenders[path.name] = hits
    unexpected = {name: lines for name, lines in offenders.items() if name not in ALLOWED}
    assert not unexpected, f"direct clock calls outside lifecycle.clock: {unexpected}"
    stale = set(ALLOWED) - set(offenders)
    assert not stale, f"remove these from ALLOWED, they no longer read the clock directly: {stale}"
