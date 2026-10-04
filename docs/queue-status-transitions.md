# Queue job lifecycle (issue #194)

The Queue shows waiting jobs, active jobs, jobs awaiting plate clear, and a
Timeline. Completed job history lives in Archives. Queue History, Clear History,
Resume after failure, and the Require previous success option have been removed.

## Pause and resume (stage 4)

Fresh, connected `PAUSE` telemetry moves the identified job from `printing` to
`paused`; matching `RUNNING` telemetry moves it back to `printing`. The job keeps
its printer, Archive, original start time, and print settings throughout.
Neither transition sends a printer command or repeats print-start effects.
Pause/Resume controls send commands as before; the job changes only when the
printer reports the result. Runout, HMS pauses, and touchscreen pauses use the
same telemetry path.

If the first observation of a dispatched or external print is `PAUSE`, Grove
records its accepted `printing` job and then moves it to `paused` in the same
transaction. Startup and reconnect apply the same matching code to persisted
`printing` and `paused` jobs. Missing/different IDs, disconnected or uninitialized
telemetry, and preparation states do not resume a paused job. Delayed callbacks
are checked against the current live identity and state before writing.
An external job whose firmware ID arrives while paused keeps the same job and
Archive when that ID is bound to its session identity.

Paused jobs stay visible in Active jobs and Timeline, with **Paused** and
**Stop Print**. Stop, completion, failure, printer deletion, and Clear Plate
retain the stage 3 rules. Queue REST payloads expose `paused`; the webhook Queue
view maps it to `printing`, and its printing count and the existing Prometheus
queue printing gauge include paused work, preserving integration behavior.
Project counts and filament tracking also retain paused work.

The sidebar Queue badge and printer queue counts request `queued` waiting
jobs. Frontend queue filters accept only the lifecycle's status values, so
legacy filter names fail TypeScript checks.

Stage 4 needs no schema change or new migration: stage 3 already added `paused`
to the state table and unique holding index. On upgrade, the next matching
telemetry observation updates an existing active job. Back up the database as
for other upgrades; ambiguous jobs retain Stop as their way out.

## States and actions

| From | Allowed destinations |
| --- | --- |
| `queued` | `preheating`, `dispatching`, `unsuccessful` (user cancellation) |
| `preheating` | `dispatching`, `failed`, `cancelled` |
| `dispatching` | `printing`, `failed`, `cancelled` |
| `printing` | `paused`, `finished`, `failed`, `cancelled` |
| `paused` | `printing`, `finished`, `failed`, `cancelled` |
| `finished` | `successful` (Clear Plate) |
| `failed` | `unsuccessful` (Clear Plate) |
| `cancelled` | `finished` (identified completion), `unsuccessful` (Clear Plate) |
| `successful`, `unsuccessful` | No different destination |

Printer deletion additionally ends an active job as `unsuccessful`. It resolves
`finished` as `successful`, and `failed`/`cancelled` as `unsuccessful`; only the
unsuccessful ends record **Printer deleted**, and jobs that had already ended
keep their completion time. Waiting jobs that required that printer remain
`queued`, unassigned, so an operator can retarget them. While Grove can reach
the printer, deletion is refused during a heat soak and until its heater
shutdown is confirmed, because that retry loop needs the printer: stop the soak
first. A disconnected printer can be deleted, since Grove cannot command it.

## Waiting jobs and printers

`queued` jobs are a pool. On a `queued` job, `printer_id` means only one thing:
a **Specific machine** requirement, which the job must run on. A blank
`printer_id` is normal: an **Any machine** job carries its model (and any
cross-model alternatives) instead, and has no printer while it waits.

The scheduler picks a free, compatible printer for an Any machine job and hands
that choice, with the tray mapping computed for it, to the dispatch worker in
memory. Specific machine jobs get their tray mapping the same way, so the
scheduler never overwrites a waiting job's mapping. The worker writes both in
the same conditional update that moves the job to `preheating` or
`dispatching`, which requires an Any machine row to still be unassigned. If the
attempt backs out before that update, nothing was written, and the next pass may
choose any compatible printer.

A waiting job stays editable until its worker claims it; the claim then refuses
further edits until the worker finishes. After claiming, the worker compares
every editable field with what selection read. If an edit was accepted in
between (a new target model, tray mapping, Manual start or start time, for
example), it releases the claim without sending anything, and the next pass
decides again from the edited job. Retry of an Any machine
job returns it to the pool the same way, with its printer and tray mapping
chosen again.

Leaving the queue reserves the printer until the job reaches a final state. A
unique partial index covers `preheating`, `dispatching`, `printing`, `paused`,
`finished`, `failed`, and `cancelled`. Dispatch checks both the database hold
and connected, idle telemetry. Model, nozzle, material, and drying eligibility
are checked before starting an attempt. A problem found before the hold never
fails the job, because it was not sent anywhere: a missing or disconnected
printer leaves it waiting, and a missing source file parks it with **Manual
start** and a reason so it does not block the jobs behind it. An interruption
after reservation fails the attempt and keeps its hold. The lifecycle never
moves a job backward into `queued`.

A waiting job's status is always **Queued**. The Queue explains why it has not
started with badges derived from the job itself: **Scheduled** (a future start
time), **Manual start**, and **Waiting** (the scheduler's display-only reason,
such as a busy printer or missing material).

Turning **Require plate clear** off automatically applies the same Clear Plate
transition when a job first enters `finished`. Failed and cancelled attempts
always require an explicit Clear Plate, including failures during upload or
heat soak. This prevents the next job from draining through a failed printer.

**Cancel** on a waiting job makes it `unsuccessful`. **Cancel** and **Stop Print**
on active jobs both use `cancel_job`: commit `cancelled`, then stop the device
and shut down heat soak if needed. A failed stop command or disconnected
printer leaves an actionable hold. Editing or deleting a holding job is refused.
**Skip heat soak** proceeds into `dispatching` while keeping the same hold.
The stop request is durable, but `physical_outcome` remains empty until an
identified terminal printer report arrives. If Stop was not sent, the Queue
shows an inspection reason. A later identified completion moves the job from
`cancelled` to `finished` and corrects its attempt Archive to `completed`.
An identified abort confirms the `cancelled` outcome. Clear Plate can still
finalize an unconfirmed stop after inspection; `stop_requested_at` preserves
the attempted Stop for an Archive that finishes downloading later.

**Clear Plate** is available from the job and the printer, including while the
printer is offline. Inspect and physically clear the plate before using it.
Both actions refuse to clear a job while fresh telemetry reports an active
print. Automatic clearing also retains the finished job's hold in that case.

A touchscreen/SD print can start while an earlier job still awaits Clear Plate.
When fresh telemetry identifies that new run, its external `printing` job takes
over the reservation in the same transaction. The previous `finished`, `failed`,
or `cancelled` job becomes final with an explicit hold-transfer reason; its
Archive outcome is unchanged. This is an exception to finalization by Clear
Plate: it transfers the hold without declaring the physical plate empty. There
is still exactly one holding job, and the old Clear Plate button cannot release
the new print. Different active reservations, disconnected telemetry, delayed
starts, and previously ended identities cannot establish a transfer. The new
job follows the normal completion and plate-clear rules, including after restart.

The unconfirmed-dispatch prompt requires a submission ID, a send timestamp, and
an expired acknowledgement window. The worker first commits a `dispatching`
hold, then copies and links its Archive, then uploads it. No print command is
sent without a linked Archive. An Archive-copy failure is an ordinary
`dispatching` → `failed` transition. A restart clears stale worker claims; a
held dispatch with no submission ID or send timestamp can be failed safely,
while an attempt that might have sent its command remains held for telemetry or
manual review. The send timer starts after upload, and REST serialization and
resolution reject attempts still owned by a worker.

**Retry** on a failed or cancelled attempt creates a separate, unlinked
`queued` job at the top of the same printer/model queue, carrying the print
settings. Stop intent, submission IDs, timestamps, and physical outcomes belong
to the original attempt and are reset on the replacement. Cross-model retries
copy the available candidate slices and their
per-file settings, resetting candidate attempt counts. If none survive, Retry
uses the selected Files source or the Archive copy. Inserting this replacement
at the top requires `queue:insert_top`, as well as queue creation and ownership
update permissions. Retry does not clear the original attempt's hold. Clear Plate
is required before its replacement can use the same printer; model-based retries
can use a different free, compatible printer. Queue-only sources remain
available while a nonfinal job needs them and are removed after finalization
and commit; other queued copies keep a shared source alive.

Archive deletion and automatic purge refuse to remove a source backing any
holding job. Purge previews exclude these Archives, and deletion rechecks the
hold in the same transaction as removal of the job and statistics.
Deleting a user together with their items similarly refuses any affected hold,
including another user's job backed by that user's Files or Archive. Deleting
only the account leaves its jobs ownerless, with Clear Plate still available.

Each Queue dispatch uploads to a unique SD filename recorded in its attempt
Archive. Completion captures that filename before releasing the hold and deletes
only that upload, including after restart. Printer display names and Files and
Archive filenames retain the user's original name. Older/external prints keep
their existing cleanup naming rules.
When Stop cancels an upload, the worker drains the FTP transfer before removing
its unsent copy. A persisted command-send boundary keeps the copy available
while delivery or the printer's physical outcome remains uncertain.
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
Clear Plate, printer deletion, and an observed external hold transfer have
explicit action guards.

Printer plate-clear flags and Archive IDs are projections of the holding job.
They are rehydrated from jobs at startup and published to the manager only after
commit. Rollback discards pending view and artifact updates. The old Printer
flag columns remain solely for upgrade compatibility and are not runtime
reservation authorities.

Committed `failed` and `cancelled` transitions schedule one outcome step keyed
by job and state. It handles failure notification, configured Auto Off, heat-soak
shutdown, and cleanup of that attempt's unique SD upload. A rollback schedules
none of these effects. Notification, Auto Off, and heater cleanup each use a
separate database session; a failed query, flush, or commit in one effect cannot
prevent the later cleanup steps. Heater shutdown remains pending until fresh zero-target
telemetry confirms it, including after a failed heat-soak handoff or disconnect.
Both heater-on and heater-off commands require fresh connected idle telemetry.
Shutdown also checks the current Queue holder: a delayed effect or retry never
turns off another active print or reserved soak. It waits until that work ends.
Automatic power-off checks both live printing and active Queue reservations
immediately before switching the plug, after resolving its service. This
protects heat soak and upload while MQTT still reports idle. A failed Queue
lookup defers power-off; awaiting-plate-clear jobs can still power off.
Each committed status change also writes a compact log
entry with job, prior/new state, printer, Archive and action for support reports.

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
- Physical outcomes are backfilled before a separate one-time migration links
  unambiguous legacy active or terminal Archives by printer and submission ID.
  Link migration version 2 revisits terminal jobs missed by version 1's startup
  order. Runtime transitions never guess a legacy link.

## Names for integrations

Queue REST payloads and the Queue UI expose the job names below. Integrations
keep their existing names: print completion notifications, webhooks, the MQTT
relay and Home Assistant describe what physically happened when a print ended,
which is the moment a job enters `finished`, `failed` or `cancelled`. Plate
clearing (`successful`, `unsuccessful`) publishes no integration event.

| Job state (Queue) | Old queue name | Meaning | Integrations receive |
| --- | --- | --- | --- |
| `queued` | `pending`, `skipped` | Waiting for a free, compatible printer | `pending` (webhook Queue status) |
| `preheating` | `preheating` | Heat soak running; printer held | `preheating` |
| `dispatching` | `dispatching` | Sending the job; waiting for the printer to accept it | `dispatching` |
| `printing` | `printing` | Printing | `printing` |
| `paused` | `printing` | Paused on the printer; printer held | `printing` (webhook Queue status) |
| `finished` | `completed` | Printed; plate not yet cleared; printer held | Print event `completed` |
| `failed` | `failed` | Error after leaving the queue; plate not yet cleared | Print event `failed` |
| `cancelled` | `cancelled`, `aborted` | Stop requested or reported; plate not yet cleared | Print event `cancelled` after an identified Stop report; `aborted` for a stop on the printer |
| `successful` | `completed` | Finished, and the plate was cleared | No event |
| `unsuccessful` | `failed`, `cancelled`, `skipped` | Failed or cancelled, and the plate was cleared; or cancelled while waiting | No event |

The MQTT relay's queue job events keep their names: `job_completed` for
`completed`, and `job_failed` with status `failed` or `cancelled`.

## Scope and verification

Stage 2's strict printer/job identity matching and stage 4's durable `paused`
transitions remain in place. Stage 5 aligns Archive and hidden-source lifecycle
work with the conditional transition writer:

- The worker commits the printer hold before copying. It copies the source
  with current G-code injection, then conditionally links that immutable
  attempt to the held job before FTP upload. A losing Stop, claim, or rollback
  removes the unlinked copy. No `project_file` command is sent without the
  exact committed Archive link. A source missing before the hold keeps the
  job queued and parked; a copy failure after the hold fails the job and keeps
  the printer reserved for inspection.
- Fresh, connected idle telemetry is required before the hold, after copying,
  and immediately before the print command. A different print observed during
  copy or upload fails the held attempt. The final synchronous command runs
  under the job's short write lock, so a concurrent Stop either wins first or
  follows the send. A committed submission ID lets restart recovery distinguish
  an uncertain command from an unsent attempt.
- Heat-soak and Skip handoffs commit `preheating` → `dispatching` first, then
  let the dispatch worker copy and link. Busy or unready telemetry before the
  handoff retains the soak and returns HTTP 409 for Skip. A subsequent copy
  failure follows the same failed-dispatch path as an ordinary job. A worker
  failure affects only its own transaction and job.
- Upload, drying-policy, and rejected-command failures update the exact linked
  Archive to `failed` and retain the printer hold. Failure effects run from the
  committed transition. An Any machine assignment notice waits until the
  Archive link succeeds. Each upload has a unique SD name, so delayed cleanup
  cannot delete another attempt's file.
- An identified terminal event records the physical outcome and updates the
  exact linked Archive in the same transaction. A user Stop immediately marks
  the attempt Archive `aborted` for workflow display but leaves the physical
  outcome unconfirmed. An identified completion after a failed Stop corrects
  both job and Archive to `completed`; a confirmed abort fills the physical
  outcome once. Exact job and Archive columns must both match. Pause/resume,
  duplicate terminal observations, Clear Plate and printer deletion do not
  rewrite a confirmed physical outcome. One-time startup migration associates
  only proven legacy job/Archive pairs; reconnect and ordinary transitions do
  not perform that repair. The job retains the outcome, timestamp and failure
  reason separately from its released state. Retry starts without those facts
  from the prior attempt.
- Hidden sources are retained by every nonfinal reference, including variants.
  Finalization detaches final references and removes sources; artifact deletion
  waits for commit. Files storage and external sources are preserved.

Startup adds the nullable physical-outcome columns and performs the versioned
`queue_archive_outcome_version = 1` backfill once. Only unambiguous job states
or exact Archive/job links supply outcomes; display reasons and reprint-source
Archives do not. An old dispatch without a submission ID or send timestamp is
failed on restart; one that might have sent a command stays held for inspection.

Real database tests cover the transition table, stale sessions, rollback,
claim replacement, cancellation/confirmation/recovery races, all holding states,
auto Clear Plate, offline Clear Plate, Retry, printer deletion, migration, and
Queue-only source retention. Upload confirmation, user deletion with FK cascades,
touchscreen hold transfer, stale starts, and active-printer Clear Plate guards
also use real database tests. The full backend and frontend suites remain part
of validation.

`test_queue_paused.py` adds real-database pause/resume, initial PAUSE, external
identity binding, recovery, stale-event, and cancellation-race coverage. Queue
UI, webhook, project, and metrics regressions verify that paused work remains
visible. No existing tests are removed in stage 4.

Tests for the removed previous-success skip, cancellation cascade, independent
Printer flag persistence, and Resume after failure were replaced by
`test_queue_lifecycle.py`, `TestAwaitingPlateClearProjection`, and the updated
Queue API/source tests. The replacements check durable holds and explicit
release, rather than mocking the transition writer or identity resolver.

SQLite is exercised locally. PostgreSQL upgrade/concurrency and physical printer
qualification still require validation. On hardware, verify successful
completion with confirmation on/off, failed uploads, heat-soak interruption,
Stop while offline, Retry followed by Clear Plate, restart/reconnect, and two
printers working independently. Also start a touchscreen/SD print while an old
job awaits Clear Plate, confirm that its hold transfers, and try the old Clear
Plate action while the new print is running. The original stage 2 identity qualification
checklist remains in [queue-job-identity.md](queue-job-identity.md).
For stage 4, additionally verify manual Pause/Resume, filament runout and HMS
pauses, touchscreen/SD starts first observed in PAUSE, restart/reconnect while
paused, Stop while paused, and completion/failure directly from PAUSE. Confirm
the same job/Archive IDs and printer hold throughout, with no repeated start
notification. Physical printer and PostgreSQL qualification remain outstanding.

For stage 5, additionally verify an upload failure produces one failed Archive
and retains the printer hold; Cancel during copying leaves no Archive or MQTT
command; Cancel during upload preserves an aborted Archive; completed/skipped
heat soaks create their Archive only at dispatch; and a reprint uploads exactly
its new copy with current snippets once. Restart during upload and dispatch
confirmation, complete external and paused jobs, and compare Archive outcome
and timestamps before and after Clear Plate. Retain a shared hidden upload
until every direct and variant reference is final, and confirm saved Files
copies remain. PostgreSQL must additionally exercise competing dispatch/Stop,
rollback and shared-source finalization with real concurrent connections.
Also finish a slow external Archive download after failure/Stop and Clear
Plate, advance multiple heat soaks while one printer becomes busy during
copying, and confirm Auto Off after a copy failure on ordinary and heat-soak
jobs. Verify the one-time outcome backfill on a pre-stage-5 PostgreSQL database.
Reconnect during a heat-soak Archive copy and verify fresh busy or unready
telemetry prevents upload and dispatch; a fresh idle report permits the
handoff. Retry failed and cancelled jobs from Files, Archive and variants,
then cancel the queued retry and confirm the original outcome is unchanged.
Restore an active job referencing an older unlinked Archive, then finish, fail,
Stop or recover it by exact submission ID. Confirm the one-time migration links
only an unambiguous attempt and that later outcomes update that link; repeat
with reused IDs and source Archives to confirm they remain untouched. Include
a late firmware-ID rebind and concurrent Stop/completion on PostgreSQL.
Fail an external Archive link after creation, then supply its firmware ID or
Stop and Clear Plate; verify the same Archive records the outcome. Let an old
Auto Off task become due during a new heat soak/upload, including during plug
service resolution, and confirm the reserved printer retains power.

`test_queue_archive_alignment.py` covers real-database dispatch/Archive commit,
rollback (including session close), cancellation during copying, duplicate
handoffs, outcomes and auto/manual Clear Plate, exact reprint links, copy
failure, and variant-source retention. No existing tests were removed in
stage 5. Earlier late-Archive and original-source upload expectations in
`test_scheduler_cleanup_library.py` are replaced by early failed-attempt and
immutable-copy checks; the same cancellation and MQTT fencing cases remain.
`test_queue_legacy_archive_alignment.py` additionally exercises real migrations,
completion callbacks and independent lifecycle paths for restored active
Archives, plus rollback, stale completion, late ID binding and ambiguous matches.
`test_queue_dispatch_contracts.py`, `test_queue_dispatch_races.py`, and
`test_queue_outcome_effects.py` cover hold-first copying, Stop races, rollback,
and after-commit effects. Scheduler watchdog tests cover restart before a
command has an ID, both before and after Archive linking.
