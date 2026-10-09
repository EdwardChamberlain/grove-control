"""Regression coverage for restart-safe print webhook ownership."""

from types import SimpleNamespace

import pytest

from backend.app.services.print_effects import _archive_notification_data, _job_notification_data


def _completion(owner_id):
    return SimpleNamespace(job_id=17, owner_id=owner_id, archive_id=5, data={"status": "completed"})


def _archive(created_by_id):
    return SimpleNamespace(
        created_by_id=created_by_id,
        started_at=None,
        completed_at=None,
        print_time_seconds=None,
        filament_used_grams=None,
        failure_reason=None,
        extra_data=None,
        file_path=None,
    )


async def test_queued_print_notification_uses_persisted_job_owner():
    """A queued run belongs to its queue owner, not the archive uploader.

    This is the completion-after-restart case: no printer-manager memory is
    involved, so the persisted queue row must win.
    """
    data = await _archive_notification_data(_completion(42), _archive(99), [], None, db=None)
    assert data["owner_id"] == 42
    assert data["created_by_id"] == 99


@pytest.mark.parametrize("archived", [True, False])
async def test_external_print_notification_has_no_owner(archived):
    """Every print is a job (#194): a printer-started one is ownerless, whoever uploaded its file."""
    if archived:
        data = await _archive_notification_data(_completion(None), _archive(99), [], None, db=None)
    else:

        class _Session:
            async def get(self, *_args):
                return None

        data = await _job_notification_data(_completion(None), [], _Session())
    assert data["owner_id"] is None
