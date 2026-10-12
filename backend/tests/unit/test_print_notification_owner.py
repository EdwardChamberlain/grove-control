"""Regression coverage for restart-safe print webhook ownership."""

from backend.app.main import _resolve_print_notification_owner_id


def test_queued_print_notification_uses_persisted_job_owner():
    """A queued run belongs to its queue owner, not the archive uploader.

    This is the completion-after-restart case: no printer-manager memory is
    involved, so the persisted queue row must win.
    """
    assert (
        _resolve_print_notification_owner_id(
            completed_queue_item_id=17,
            completed_queue_item_owner_id=42,
            archive_created_by_id=99,
        )
        == 42
    )


def test_nonqueued_print_notification_falls_back_to_archive_creator():
    """Printer-initiated prints retain the existing archive-owner fallback."""
    assert (
        _resolve_print_notification_owner_id(
            completed_queue_item_id=None,
            completed_queue_item_owner_id=None,
            archive_created_by_id=99,
        )
        == 99
    )
