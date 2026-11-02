"""Gate backend coverage on line coverage and report branch coverage.

With branch measurement on, coverage.py folds branches into its TOTAL
percentage, so `coverage report --fail-under` would gate on a figure that is
not the line floor in CLAUDE.md. This script reads `coverage json` output on
stdin, reports line and branch totals separately, and fails only when the line
percentage is below --fail-under. The line figure is rounded to the report's
one decimal place before the comparison, the same way coverage.py rounds it.

Usage (from backend/):
    coverage json -q -o - | python ../scripts/coverage_gate.py --fail-under 80.0

When GITHUB_STEP_SUMMARY is set (GitHub Actions), a table is appended to the
job summary as well.
"""

import argparse
import json
import os
import sys


def percent(covered: int, total: int) -> float | None:
    return 100.0 * covered / total if total else None


def format_percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1f}%"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fail-under", type=float, required=True, help="minimum line percentage")
    args = parser.parse_args()

    totals = json.load(sys.stdin)["totals"]
    lines = percent(totals["covered_lines"], totals["num_statements"])
    branches = percent(totals["covered_branches"], totals["num_branches"])
    if lines is None:
        print("No statements measured; cannot gate line coverage.", file=sys.stderr)
        return 1
    passed = round(lines, 1) >= args.fail_under

    rows = [
        (
            "Lines (gated)",
            totals["covered_lines"],
            totals["num_statements"],
            lines,
            f">= {args.fail_under:.1f}% " + ("pass" if passed else "FAIL"),
        ),
        ("Branches (report only)", totals["covered_branches"], totals["num_branches"], branches, "not gated"),
    ]
    for name, covered, total, value, gate in rows:
        print(f"{name}: {format_percent(value)} ({covered}/{total}) {gate}")

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write("## Backend coverage\n\n")
            summary.write("| Measure | Covered | Total | Percent | Gate |\n")
            summary.write("| --- | ---: | ---: | ---: | --- |\n")
            for name, covered, total, value, gate in rows:
                summary.write(f"| {name} | {covered} | {total} | {format_percent(value)} | {gate} |\n")
            summary.write("\n")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
