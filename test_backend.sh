#!/bin/sh
set -e

cd backend
ruff check && ruff format --check

# Mirrors CI's Backend Coverage job, including its line floor. Branch coverage
# is reported but not gated, so the floor is checked by scripts/coverage_gate.py
# rather than --cov-fail-under (which would use the combined line+branch total).
../venv/bin/python3 -m pytest tests/ -v -n 30 --cov=app --cov-report=term-missing:skip-covered
../venv/bin/python3 -m coverage json -q -o - | ../venv/bin/python3 ../scripts/coverage_gate.py --fail-under 80.0
