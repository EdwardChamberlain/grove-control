"""Durable replacements for the former process-local expected-print tests."""

import json

import pytest

from backend.app.main import _resolve_print_ams_mapping, _resolve_print_plate_id
from backend.app.models.print_queue import PrintQueueItem


def test_print_start_context_is_read_from_the_owning_job_not_an_archive_key():
    job = PrintQueueItem(ams_mapping=json.dumps([2, -1, 5]), plate_id=3)

    assert _resolve_print_ams_mapping({}, job) == [2, -1, 5]
    assert _resolve_print_plate_id({}, job) == 3


def test_event_context_takes_precedence_over_durable_job_context():
    job = PrintQueueItem(ams_mapping=json.dumps([2, -1, 5]), plate_id=3)

    assert _resolve_print_ams_mapping({"ams_mapping": [7]}, job) == [7]
    assert _resolve_print_plate_id({"plate_id": 4}, job) == 4


@pytest.mark.parametrize("value", [None, "", "not-json", {"wrong": True}])
def test_invalid_event_mapping_is_ignored(value):
    assert _resolve_print_ams_mapping({"ams_mapping": value}) is None
