# Queue job lifecycle (issue #194)

The Queue shows waiting jobs, active jobs, jobs awaiting plate clear, and a
Timeline. Archive is the print history. Queue History, Clear History, Resume
after failure, and Require previous success have been removed.

## States and actions

| From | Allowed destinations |
| --- | --- |
| `queued` | `preheating`, `dispatching`, `unsuccessful` (user cancellation) |
| `preheating` | `dispatching`, `failed`, `cancelled` |
| `dispatching` | `printing`, `failed`, `cancelled`, `unsuccessful` (Retry of an unsent attempt) |
| `printing` | `paused`, `finished`, `failed`, `cancelled` |
| `paused` | `printing`, `finished`, `failed`, `cancelled` |
| `finished` | `successful` (Clear Plate) |
| `failed` | `unsuccessful` (Clear Plate) |
| `cancelled` | `finished` (identified completion), `unsuccessful` (Clear Plate) |
| `successful`, `unsuccessful` | No different destination |

Active and awaiting-plate-clear states hold the printer. A unique partial index
on `printer_id` allows only one holding job per printer. The lifecycle never
moves a job backward into `queued`. Printer deletion additionally releases an
active job as `unsuccessful`; finished work becomes `successful`, and other
held terminal work becomes `unsuccessful`. Queued jobs remain waiting,
unassigned, with a reason. Reachable heat-soak printers cannot be deleted until
their heaters have been shut down; disconnected printers can be deleted.

**Cancel** ends a waiting job as `unsuccessful`. **Cancel / Stop Print** on active
work commits `cancelled`, records Stop intent, then sends Stop. A failed command
or offline printer keeps the hold with an inspection reason. If fresh telemetry
shows the printer running a different identified print, the job is stopped
without a Stop command, which would stop that print, and without Auto Off. Editing and
deleting holding jobs is refused. **Skip heat soak** proceeds to `dispatching`
with the same hold.

**Clear Plate** releases `finished` as `successful`, or `failed` / `cancelled`
as `unsuccessful`. Inspect and physically clear the plate first. This action is
available from the job and printer, including offline, but refuses while fresh
telemetry reports active printing. With **Require plate clear** off, entry into
`finished` applies the same action automatically, unless the printer is active.
Failed and cancelled jobs always require explicit clearing.

**Retry** creates a separate `queued` job at the top of the same printer/model
queue, with the original print settings and automatic scheduling. Stop intent,
Manual start, submission IDs, attempt timestamps and physical outcomes reset.
Retry repeats the complete heat soak and retains available variant slices and
per-file settings. If those are gone, it uses the selected Files source or the
Archive copy. It requires queue creation, ownership update and `queue:insert_top`
permissions. The old job retains its hold; a model-targeted retry can use a
different free printer. Retry is also offered on a `dispatching` attempt that
nothing was sent for and no worker still owns. That attempt is withdrawn as
`unsuccessful` in the same transaction, releasing its hold and removing its
upload, because there is no plate to clear.

A new, positively identified touchscreen/SD print can transfer an earlier
terminal job's hold. The old job becomes final and the new external job takes
the reservation in one transaction. This does not assert that the plate was
cleared, and does not rewrite the old Archive outcome. The old Clear Plate
action cannot release the new job. An existing active job, stale telemetry, or
a previously ended identity cannot establish this transfer.

## Dispatch

Every new job enters `queued` through `create_job` in
`services/lifecycle/queued.py`, whether from the Queue, Files, a webhook, a
virtual printer or Retry. It places jobs in their queue under one lock: at the
end, at a position later jobs make room for, or (Retry) ahead of every waiting
job that could take the same printer.

`queued` jobs form a pool. A populated `printer_id` is a **Specific machine**
requirement; an **Any machine** job remains unassigned until its hold commits.
Each scheduler pass, printer selection (`services/printer_selection.py`)
chooses the printer and its tray mapping (`services/ams_mapping.py`) in memory.
Eligibility checks cover model, nozzle, material, drying (`services/ams_drying.py`)
and fresh idle telemetry. Selection, mapping and drying are standalone services
that the scheduler composes; drying is not lifecycle code, and selection and
dispatching only ask whether it blocks a print. A missing
printer leaves the job queued. Missing sources park it with Manual start and a
reason; the system never ends a queued job. Files purging likewise detaches
missing sources without cancelling waiting jobs.

Leaving the queue is queued's exit. A bounded pool of exit workers, one session
each, rechecks the selected printer and source and starts preheating for a heat
soak or dispatching otherwise. Their entry takes the printer's lock, re-reads
the job and holds the printer only if the job is unchanged since its selection,
so an edit accepted in between always wins and causes a fresh selection.
Printer and tray mapping are persisted only by that hold. A blocked job stays
queued with its reason. `services/lifecycle/dispatching.py` owns the attempt:
`Dispatcher.enter` holds the printer when entered from `queued`, or inherits the
soak's hold from `preheating`, then copies, links, uploads and sends, one step
each. A soak's entry into dispatching (its deadline or **Skip heat soak**)
starts the dispatch once the handoff commits. Which jobs a worker still owns is
the in-process worker registry: only one Grove process runs per database
(`services/lifecycle/lease.py` refuses a second at startup).

Dispatch follows this order:

1. Commit the printer hold: `queued` or `preheating` → `dispatching`.
2. Copy the exact file with current G-code injection.
3. Link the new Archive to that job and commit.
4. Upload its unique SD filename and persist a fresh submission ID.
5. Commit the send timestamp with an acknowledgement deadline, recheck the job
   and telemetry, and publish.

Each step locks the job and confirms the attempt still holds it before it
writes, so a Stop or recovery that ended the attempt makes it stand down.
No print command is sent without its committed Archive. Copy failures use the
ordinary `dispatching` → `failed` path. Stop cancels the attempt's worker:
during copying the copy is discarded, during upload the transfer drains and the
unsent upload is removed. The final MQTT publish happens under the job's lock:
Stop wins before it, or follows the send with a Stop command. Slow I/O and
reconnect waiting never hold the lock. Stop sends a Stop command only for a
print that may have been sent, never for a soak or an unsent upload.

Missing or uninitialized telemetry waits for up to 30 seconds at each dispatch
boundary. An active print state or a different nonempty identity fails the
held attempt. An empty ID after reconnect is not evidence of another print.
If telemetry remains unavailable, nothing is sent: the job stays `dispatching`
with **Retry** instructions, without a failure notification or Auto Off, and a
soak's heaters are shut down. A restart parks an interrupted unsent attempt the
same way. Retry withdraws such an attempt and releases the printer without a
plate check, because nothing was sent.

A sent attempt waits on its acknowledgement deadline: the printer has 90
seconds to report the print's ID and, once it has, 180 more to start it.
Intake confirms an observed start at once. A deadline that falls due without a
confirmation holds the job for review, resetting the MQTT session if the ID
never arrived. The unconfirmed-dispatch prompt requires an ID, a send
timestamp, an expired 270-second window, and no live worker. **It's printing**
confirms `printing`; **It didn't start** records `failed`. Printing's entry
from `dispatching` registers the queue-start notification and relay
publication, which re-reads the job after commit: rollback emits no start, and
a print that ends in the transaction that confirmed it announces only its end.

## Waits and recovery

A job's pending wait is a deadline on its row (`deadline_at`,
`deadline_kind`): a soak's end, or a sent attempt's acknowledgement. The engine
clears it on every status change unless the transition sets a new one. One
loop, `services/lifecycle/deadlines.py`, runs due deadlines, then recovery and
heater-shutdown retries. It sleeps until the next deadline or 30 seconds,
whichever is sooner, and wakes early when a commit sets a deadline or a printer
connects or disconnects. Queue selection is the scheduler's only loop.

A live soak carries its `soak_end` deadline. When it falls due the soak hands
off to dispatching once the printer is idle. While it runs, each tick ends it
if the printer becomes unavailable. At startup a soak that still has a deadline
was interrupted: its heaters are turned off and its hold is kept, with an
inspection message and no deadline, until a person stops it or skips the soak.

Recovery is one rule. Each tick, every `dispatching`, `printing` or `paused`
job that no worker owns is read under its printer's lock and compared with
fresh telemetry, then settled with the functions a live event uses: a
reported end through `printing.end`, an active print by confirming it and
syncing pause state. Without fresh telemetry nothing is decided, so a sent job
is never resolved from missing or stale reports. A `printing` or `paused` job
whose printer reports a different firmware print ID ended unobserved: its
outcome is unknown, so it becomes `failed` without Auto Off, and an active
replacement print is then observed as started, which transfers the hold to it.
A session-local ID on either side proves nothing, and the job stays put. A
print an older version archived without a job becomes an ownerless job once
fresh telemetry reports its exact, unique ID, and is then recovered like any
other.

A stored tray mapping that maps no slot (`[-1]`) is never sent (#2589). Printer
selection recomputes it from the loaded trays, and the job waits with a reason
while nothing matches.

See
[job identity](queue-job-identity.md) for matching and recovery details and
[concurrency](queue-dispatch-concurrency.md) for upload pool settings.

## Identity, pause and Archive outcomes

MQTT print events reach the lifecycle through intake
(`services/lifecycle/intake.py`); the `main.py` callbacks only hand them on.
Intake runs each printer's start, pause/resume, completion and reconnect events
one at a time, matches each to its job, and keeps the per-print memory events
need: whose start and completion already ran, a Stop sent from the printer
controls, finish-photo frames and producer events, timelapse baselines, and
bed-cooldown waiters. The photo-moment and bed-temperature adapters also enter
through intake. Heavy services receive its `PrintMemory` explicitly and keep
no global per-print context.

Start, pause and completion match printer plus persisted submission ID, never
filename, display name or recency. Printing (`services/lifecycle/printing.py`)
confirms a dispatched job on its observed start, or adopts a print the printer
started itself as a new ownerless job.
Fresh `PAUSE` / `RUNNING` telemetry changes `printing` / `paused` without
replaying start effects, changing settings or releasing the hold. First
observation in PAUSE records printing and paused in the same transaction.
Delayed observations must still match current identity and state.

The Queue records physical outcome, completion time and failure reason before
Clear Plate collapses workflow state into `successful` / `unsuccessful`.
The exact owned Archive mirrors those facts. A Grove Stop immediately displays
`aborted` in Archive but leaves physical confirmation pending. Identified
firmware `FAILED` after Grove Stop confirms `aborted` with **User cancelled**;
a genuine failure records `failed`. Identified FINISH after an unconfirmed Stop
permits `cancelled` → `finished` and records `completed`. Confirmed outcomes
cannot be overwritten by duplicate reports. `stop_requested_at` preserves Stop
intent across restart and a late Archive download.

A printer's completion report ends the job through printing's exit
(`printing.end`) into the awaiting state for its outcome. A Grove Stop is
reported as `cancelled`, also after a restart. The completion credits the
job's owner, read from the job in the completion transaction, in the print log
and on an unowned reused Archive; nothing is kept in memory, so the credit
survives a restart. The current-print-user route reads the active job's owner.

The start and completion effects (Archive association, new-print actions,
notifications, usage tracking, photos, energy and SD cleanup) live in
`services/print_effects.py`. They run from the effects registry once the
transition that observed the start or end commits, and intake waits for them
before the printer's next event. Printer-supplied file names are joined under
the download directory with `safe_join_under`.

Archive association and new-print effects are separate. Recovery restores file,
usage and object context without replaying plate checks, notifications, usage
initialization or power-on actions. Skipped objects and an existing timelapse
baseline are preserved. Runtime tracking is restored only if fresh telemetry
still identifies that active print after Archive I/O.

The lifecycle loop repairs missing Archive links for started, identified jobs at
most once per minute. MQTT status pushes do not launch
retries. A committed Archive's unique job owner restores a missing Queue link
without another download; failed writes reuse cached 3MF files. Repair may
finish after completion and uses the retained physical facts. Legacy association
runs once during migration; normal transitions only restore an exact owned link.

Each attempt has a unique recorded SD upload name, preserving the user's display
filename. Completion and failed-attempt Clear Plate delete only that upload,
best-effort after commit. Clear Plate cleanup also covers offline Stop and
never repeats notification or Auto Off. If fresh telemetry becomes active before
cleanup, deletion is skipped. FTP failure does not undo plate clearing.

## Transactions and effects

`transition_queue_item` in `services/lifecycle/engine.py` is the sole status
writer. A transaction takes a printer's lock when it first locks or writes a
job holding that printer, and keeps it until the transaction ends, so each
printer's job has one writer at a time; take it before the transaction's first
write. The writer checks allowed edges and conditionally matches ID and
expected state. Metadata is written atomically; ORM synchronization cannot
flush a second unconditional status update. Same-state writes still check
persisted state. Reasons are display-only. Writers read under the lock, so a
losing update (`QueueTransitionConflict`) is left only for the shared queued
pool. Invalid edges fail before writing. User cancellation, Clear Plate,
printer deletion, hold transfer and printer reports have explicit action
guards. After the write, the engine aligns the Archive attempt, runs the old
state's exit step and then the new state's entry step, all in the same
transaction.

Each state's steps live in its module in `services/lifecycle/`: `queued.py`,
`preheating.py`, `dispatching.py`, `printing.py` (`printing`, `paused`),
`awaiting.py` (`finished`, `failed`, `cancelled`) and `final.py` (`successful`,
`unsuccessful`). Leaving `preheating` other than for `dispatching` shuts its
heaters down. Leaving `dispatching`, `printing` or
`paused` for `failed` or `cancelled` shuts down the heaters an inherited soak
left on; a dispatch that fails, unless the printer reported it, also removes its
unsent upload. Entry into an awaiting state writes the physical outcome with the
status, then clears a finished plate when confirmation is off, or queues Auto
Off and, unless the printer reported the failure, a failure notification. The
effects an exit and an entry queue for one outcome run together after commit.
Clear Plate, hold transfer and printer deletion end a job through `final.end`.
Machine-level hold transfer and printer deletion live in the engine, including
deletion's heat-soak shutdown guard. Leaving `failed` or `cancelled` through
Clear Plate removes the attempt's sent upload; a state cleans up on its own
exit. Entry into a final state releases unused Queue sources.

Preheating turns its heaters on only once its hold has committed, re-reading the
job under its lock first, so a Stop committed in between prevents any heater
command.

The caller owns the transaction. Lifecycle work queues
after-commit effects and rollback cleanup in one registry,
`services/lifecycle/effects.py`. Async work, such as the queue start and the
print start and completion effects, runs in order in one task per commit, which
the caller may wait for; the first failure reaches the waiter and never skips
the work after it. Effects run
only after the outermost commit; savepoints neither run nor discard them, and a
failing effect is logged without affecting the commit or later effects.
Plate-clear flags and Archive IDs in printer views are projections, rehydrated
at startup and published after commit. Rollback discards pending effects and
prepared artifacts. Legacy Printer flag columns remain only for upgrade
compatibility.

One committed outcome step, keyed by job and new state, handles failure notices,
configured Auto Off, heater shutdown and SD cleanup. Each effect uses independent
scalar inputs and database sessions, so a failed notification cannot prevent
cleanup. Heater shutdown remains pending until fresh zero-target reports confirm
it. It requires idle telemetry and no uploading or potentially sent job. Auto
Off rechecks both live printing and active Queue reservations immediately before
switching the plug; a failed lookup defers it. Every committed state change, and
every same-state write that names an action, logs job, old/new state, printer,
Archive and action. A persisted transition table
remains separately tracked in #202.

Hidden Queue sources survive every nonfinal direct or variant reference.
Finalization removes unused sources after commit; saved Files and external
sources remain. Archive deletion/purge and user-with-items deletion refuse
any affected hold, including an Archive whose job owner exists before its Queue
link. Account-only deletion leaves jobs ownerless with their controls available.

## One process per database

Each printer's writer and the worker registry live in process memory, so only
one Grove process may run against a database. Startup takes a lease (a lock
file beside a SQLite database, a session advisory lock on PostgreSQL) and
refuses to start if another process holds it. Run one container or service
instance, with one uvicorn worker. The operating system or database releases
the lease if the process dies.

## One-time upgrade

Back up the database. Startup repairs legacy schemas and migrates in one
transaction, recording `queue_lifecycle_version=3`; subsequent starts only ensure
the holding index exists.

- `pending` / `skipped` become `queued`, with stale skip reasons cleared.
- Historical completed work becomes `successful`; old failures/cancellations
  become `unsuccessful`, except the job proven to own a legacy plate-clear hold.
- An unidentified plate flag becomes a visible external `finished` job.
- Conflicting reservations retain the strongest active attempt; others become
  `unsuccessful` with an upgrade reason before index creation.
- Physical facts are backfilled once (`queue_archive_outcome_version=1`) using
  unambiguous states or exact owned links, never display reasons or source Archives.
- Legacy Archive association runs once by printer and submission ID. Link version
  2 revisits terminal jobs missed by version 1's startup ordering.

## Integrations and qualification

REST and UI use the lifecycle names. Completion integrations keep `completed`,
`failed`, `aborted`, and `cancelled` for Grove Stop. Clear Plate emits no physical
completion event. Webhook Queue waiting remains `pending`; paused jobs remain
included in integration printing counts, project counts and filament tracking.
Queue badges count `queued` work.

Real database tests cover conditional writes, rollback, migration, hold/copy/link,
Stop races, reconnect waiting, Archive repair, physical outcomes, source retention
and independent deletion consumers. SQLite is exercised locally; PostgreSQL and
hardware qualification remain required before closing #194.

QC should exercise success with confirmation on/off; failed copy/upload; complete
and skipped heat soak; Pause/Resume and runout; offline Stop followed by Clear
Plate; Retry; restart before/after send; reconnect during copy/upload; external
prints with zero and late firmware IDs; late Archive repair after finalization;
touchscreen hold transfer; unique SD cleanup; Auto Off during a new reservation;
and two printers progressing independently. Verify real concurrent dispatch,
Stop/completion and migration on PostgreSQL.
