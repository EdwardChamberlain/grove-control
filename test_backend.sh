#!/bin/sh
set -e

cd backend
ruff check && ruff format --check

# Mirrors CI's Backend Coverage job, including its floor.
../venv/bin/python3 -m pytest tests/ -v -n 30 --cov=app --cov-report=term-missing:skip-covered --cov-fail-under=70.5
