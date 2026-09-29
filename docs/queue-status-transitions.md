# Queue status transitions (issue #194, stage 1)

Stage 1 centralizes writes to the existing queue status column. It does not
introduce the later lifecycle names, change plate-clear behavior, remove the
previous-success gate, or change retry, Archive, notification or heater policy.
There is no schema change or new data migration. Existing startup repairs keep
their current selection rules and use the same status writer.

## Current transitions

| From | Allowed destinations |
| --- | --- |
| `pending` | `preheating`, `dispatching`, `failed`, `skipped`, `cancelled` |
| `preheating` | `pending`, `dispatching`, `failed`, `cancelled` |
| `dispatching` | `pending`, `printing`, `completed`, `failed`, `cancelled` |
| `printing` | `completed`, `failed`, `cancelled` |
| `skipped` | `pending`, `cancelled` |
| `failed` | `pending` (existing heat-soak dispatch cleanup) |
| `completed`, `cancelled` | No different destination |
| `aborted` (legacy rows only) | `cancelled` (startup repair) |

Reapplying the same known status is a guarded write: heat-soak handoff and
cleanup, and recovered completion callbacks already need this behavior. It
still requires the database status to match. These are today's edges, not the
future state table in #194. For example, a preflight failure can still fail a
pending job and a heat-soak interruption still returns it to manual-start pending.

## Writing a transition

Use `backend.app.services.queue_transitions.transition_queue_item` with the
observed expected status and desired destination. Its conditional SQL update
matches both ID and expected status. Dispatch also supplies its existing claim
timestamp condition. Metadata that must change in that statement goes in
`values`; the writer synchronizes the ORM object without marking status dirty
and producing an unconditional second update during flush.

The caller owns the transaction. Commit before running the existing post-commit
effects. On `QueueTransitionConflict` nothing was written: do not continue the
losing operation. A single-item operation rolls back, and HTTP callers receive
409 with a refresh/retry message. Work that handles several items in one
transaction skips the changed item and continues with the rest. The scheduler
pass does this for restart recovery and the previous-success skip, and
"Resume after failure" restores every item that is still skipped and reports
that count. A heat-soak dispatch that loses the race still turns its heaters
off.

An invalid edge raises `InvalidQueueTransition` before any update. Reasons
remain ordinary metadata; the writer never parses them to decide whether an
edge is allowed.

New queue rows still start with their normal `pending` initial value. Creation
is not a transition. Existing rows, including those repaired at startup, must
use the writer. The model rejects direct status assignments on persisted or
detached rows, even if the transition module has not been imported. Architecture
tests check SQLAlchemy bulk status updates and raw SQL status repairs outside
the writer, and require the table to cover every API status.

The heat-soak row-lock helper updates only the row ID to itself;
it does not write status. Archive and scheduled-drying statuses belong to their
own models and are outside this queue refactor.

Repeated scheduler failure paths share a helper that writes the reason and
completion time atomically with the status, then commits before side effects.
Paths that also update an Archive keep their joint transaction.

The database-backed tests exercise allowed workflows, invalid edges, stale
sessions, deletion, replaced claims, rollback, ORM flush behavior, dirty metadata
on conflict, drying reservation release after cancellation, a Stop racing
dispatch confirmation, and a cancellation racing restart recovery, a heat-soak
dispatch and "Resume after failure". Completion callback tests use real
database matching and transitions, independent sessions, mocked printer FTP,
and scoped background-task cleanup. No existing tests were removed.
