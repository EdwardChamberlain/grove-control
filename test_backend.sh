#!/bin/sh
set -e

cd backend
ruff check && ruff format --check

if [ "$1" = "--full" ]; then
../venv/bin/python3 -m pytest tests/unit/services/test_bambu_ftp.py -v
fi

../venv/bin/python3 -m pytest tests/ -v -n 30 --ignore=tests/unit/services/test_bambu_ftp.py --cov=app --cov-report=term-missing:skip-covered --cov-fail-under=53
