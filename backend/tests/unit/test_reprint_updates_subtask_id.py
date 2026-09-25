"""Task identity generation tests for requeued PrintJobs."""

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.print_job_lifecycle import admit_job, create_retry_job


@pytest.mark.asyncio
async def test_retry_does_not_reuse_predecessor_task_identity(db_session):
    original = PrintQueueItem(status="completed", lifecycle_state="completed", dispatch_subtask_id="old-task")
    db_session.add(original)
    await admit_job(db_session, original)
    original.physical_execution_observed = True
    retry = await create_retry_job(db_session, original, source="requeue")

    assert retry.previous_job_id == original.job_id
    assert retry.dispatch_subtask_id is None
    assert retry.job_id != original.job_id
