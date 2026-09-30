# Queue job lifecycle (issue #194, stage 3)

The Queue shows waiting jobs, active jobs, jobs awaiting plate clear, and a
Timeline. Completed job history lives in Archives. Queue History, Clear History,
Resume after failure, and the Require previous success option have been removed.

## States and actions

| From | Allowed destinations |
| --- | --- |
| `queued` | `preheating`, `dispatching`, `unsuccessful` (user cancellation) |
| `preheating` | `dispatching`, `failed`, `cancelled` |
| `dispatching` | `printing`, `failed`, `cancelled` |
| `printing` | `paused`, `finished`, `failed`, `cancelled` |
| `paused` | `printing`, `finished`, `failed`, `cancelled` |
| `finished` | `successful` (Clear Plate) |
| `failed`, `cancelled` | `unsuccessful` (Clear Plate) |
| `successful`, `unsuccessful` | No different destination |

Printer deletion additionally ends an active job as `unsuccessful`. It resolves
`finished` as `successful`, and `failed`/`cancelled` as `unsuccessful`, recording
**Printer deleted**. Waiting jobs remain `queued` with their printer assignment
removed so an operator can retarget them.

A targeted `queued` job has no printer reservation. Leaving the queue reserves
the printer until the job reaches a final state. A unique partial index covers
`preheating`, `dispatching`, `printing`, `paused`, `finished`, `failed`, and
`cancelled`. Dispatch checks both the database hold and connected, idle
telemetry. Model, nozzle, material, and drying eligibility are checked before
starting an attempt; an interruption after reservation fails the attempt and
keeps its hold. The lifecycle never moves a job backward into `queued`.

Turning **Require plate clear** off automatically applies the same Clear Plate
transition when a job first enters `finished`. Failed and cancelled attempts
always require an explicit Clear Plate, including failures during upload or
heat soak. This prevents the next job from draining through a failed printer.

**Cancel** on a waiting job makes it `unsuccessful`. **Cancel** and **Stop Print**
on active jobs both use `cancel_job`: commit `cancelled`, then stop the device
and shut down heat soak if needed. A failed stop command or disconnected
printer leaves an actionable hold. Editing or deleting a holding job is refused.
**Skip heat soak** proceeds into `dispatching` while keeping the same hold.

**Clear Plate** is available from the job and the printer, including while the
printer is offline. Inspect and physically clear the plate before using it.

**Retry** on a failed or cancelled attempt creates a separate, unlinked
`queued` job at the top of the same printer/model queue, carrying the print
settings. Cross-model retries copy the available candidate slices and their
per-file settings, resetting candidate attempt counts. If none survive, Retry
uses the selected Files source or the Archive copy. Inserting this replacement
at the top requires `queue:insert_top`, as well as queue creation and ownership
update permissions. Retry does not clear the original attempt's hold. Clear Plate
is required before its replacement can dispatch. Queue-only sources remain
available while a nonfinal job needs them and are removed after finalization
and commit; other queued copies keep a shared source alive.

Archive deletion and automatic purge refuse to remove a source backing any
holding job. Purge previews exclude these Archives, and deletion rechecks the
hold in the same transaction as removal of the job and statistics.

Each Queue dispatch uploads to a unique SD filename recorded in its attempt
Archive. Completion captures that filename before releasing the hold and deletes
only that upload, including after restart. Printer display names and Files and
Archive filenames retain the user's original name. Older/external prints keep
their existing cleanup naming rules.
Live covers and object reloads use the matching job's recorded upload path,
so the original display name still works with cached files and after restart.

## Conditional writes and views

`transition_queue_item` remains the sole status writer. It conditionally matches
ID, expected status, and any supplied dispatch claim. Metadata changes in the
same update; the ORM object is synchronized without a second status write.
Same-state writes still check the persisted status. Reasons are metadata and
never determine which transitions are allowed.

The caller owns the transaction. A losing compare-and-set raises
`QueueTransitionConflict`; no losing operation may publish effects. Invalid
edges raise `InvalidQueueTransition` before writing. User cancellation,
Clear Plate, and printer deletion have explicit action guards.

Printer plate-clear flags and Archive IDs are projections of the holding job.
They are rehydrated from jobs at startup and published to the manager only after
commit. Rollback discards pending view and artifact updates. The old Printer
flag columns remain solely for upgrade compatibility and are not runtime
reservation authorities.

## One-time upgrade

Startup performs the migration after legacy table rebuilds and schema repair,
in the same transaction, and records `queue_lifecycle_version=3`. Later startups
only ensure the holding index exists. Back up the database before upgrading.

- `pending` and `skipped` become `queued`; stale skip reasons are cleared.
- Active jobs retain their state and the existing startup identity checks.
- Historical `completed` becomes `successful`; historical failure/cancellation
  becomes `unsuccessful`.
- The job identified by an old plate-clear flag's exact Archive/dispatch link
  remains `finished`, `failed`, or `cancelled`. No filename or recency matching
  is used to identify that held terminal job.
- An unidentified old plate flag becomes a synthetic external `finished` job,
  so it stays visible and can be cleared instead of silently blocking scheduling.
- Conflicting legacy active reservations are repaired conservatively before
  creating the unique holding index; the strongest existing active attempt is
  retained, and other attempts become `unsuccessful` with an upgrade reason.

Queue REST payloads expose the new names. Print completion notifications,
webhooks, MQTT relay, and Home Assistant retain their existing physical outcome
names. The webhook Queue aggregate keeps its `pending` count key as a
compatibility alias for `queued`; its item payloads use the new job names.

## Scope and verification

Stage 2's strict printer/job identity matching remains in place. PAUSE telemetry
still uses the existing active print behavior: emitting durable `paused`
transitions is stage 4. Moving Archive creation to entry into `dispatching` and
consolidating all lifecycle effects are stage 5; this stage keeps the current
Archive creation timing.

Real database tests cover the transition table, stale sessions, rollback,
claim replacement, cancellation/confirmation/recovery races, all holding states,
auto Clear Plate, offline Clear Plate, Retry, printer deletion, migration, and
Queue-only source retention. The full backend and frontend suites remain part
of validation.

Tests for the removed previous-success skip, cancellation cascade, independent
Printer flag persistence, and Resume after failure were replaced by
`test_queue_lifecycle.py`, `TestAwaitingPlateClearProjection`, and the updated
Queue API/source tests. The replacements check durable holds and explicit
release, rather than mocking the transition writer or identity resolver.

SQLite is exercised locally. PostgreSQL upgrade/concurrency and physical printer
qualification still require validation. On hardware, verify successful
completion with confirmation on/off, failed uploads, heat-soak interruption,
Stop while offline, Retry followed by Clear Plate, restart/reconnect, and two
printers working independently. The original stage 2 identity qualification
checklist remains in [queue-job-identity.md](queue-job-identity.md).
