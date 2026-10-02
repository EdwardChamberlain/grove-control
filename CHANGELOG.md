# Changelog

## Unreleased

### Added

- Queue attempts now enter Archive when they enter Dispatching, before upload.
  The immutable copy includes the G-code sent for that attempt. Upload and
  command failures record their physical outcome in the same transaction as
  the Queue state; Clear Plate preserves that outcome, including external
  Archives downloaded later. Copy failures honor configured Auto Off, and a
  heat-soak handoff race does not strand other printers. Hidden uploads remain
  available until every referencing job, including file variants, is final.
  Heat-soak handoffs check fresh telemetry after reconnecting during copying,
  and Retry starts with no physical outcome from the previous job.
  Restored active Archives without a dispatch link are associated by unique
  printer and submission identity, so their completion, failure or Stop is
  recorded atomically with the job.
  Dispatch callers prepare files before taking the transition lock, so Stop
  can win during heat-soak and Skip copies too. Unready telemetry keeps the
  soak heartbeat alive without repeated copies, and one failed handoff cannot
  strand other printers. Deleted sources are rejected. Skip copy failures
  return the job's error and refresh the Queue; pool copy failures send a
  failure notification instead of an assignment notification.
  Trashed Archive reprints stay parked before taking a printer. All dispatch
  paths share copy-error reporting and retain the actual cause. The writer
  requires a prepared attempt on entry to Dispatching; copy failures take an
  explicit Failed hold directly. Skip succeeds when the same attempt has
  already progressed, without launching another worker. Repeated completion
  callbacks still repair proven legacy links and preserve physical outcomes.
  Skip also checks fresh printer readiness before and after copying and at
  handoff; unsafe telemetry retains the soak heartbeat and removes the prepared
  copy. Reconnect repairs proven legacy links for already-ended jobs without
  replaying completion effects, including after Clear Plate or a cached completion.
  Automatic heat-soak handoffs retain their heartbeat when readiness changes
  after a slow copy, so preparation does not cause a scheduler-timeout failure.

- Queue jobs now persist **Paused** from matching printer telemetry, including
  startup and reconnect, and return to Printing on resume. Paused jobs retain
  their printer hold, appear in Active jobs and Timeline, and keep Stop Print
  available. Existing webhook status names and printing counts are preserved.
  See [the lifecycle and upgrade guide](docs/queue-status-transitions.md).
- The live Queue now keeps finished, failed, and cancelled attempts visible
  until Clear Plate. Retry creates a new job without releasing the original
  printer hold; failed attempts hold even with confirmation disabled.
  Queue History, Resume after failure, and Require previous success are removed.
  See [the lifecycle and upgrade guide](docs/queue-status-transitions.md).
- Waiting jobs keep the **Queued** status and show **Scheduled**, **Manual
  start**, and **Waiting** badges for why they have not started.
- "Any machine" jobs stay unassigned while they wait. A printer is chosen and
  written to the job only when it leaves the queue, so a dispatch that backs
  out no longer pins the job to one printer. A job's printer is now only a
  "Specific machine" requirement. A disconnected printer leaves the job
  waiting; a missing source file parks it for a manual start instead of
  failing it onto a printer.

- Queue jobs now match printer events by submission ID. External prints appear
  as jobs, and startup checks include already-printing jobs.
- Unconfirmed dispatches show **It's printing** and **It didn't start** actions
  after the acknowledgement window. Interrupted heat soaks remain available
  for Stop or Skip instead of being automatically returned to the queue.
  See [stage 2 behavior and hardware validation](docs/queue-job-identity.md).

- Every Queue dispatch, including a reprint, creates its own Archive attempt.
  It records the print outcome and stores the exact file uploaded to the
  printer, including any G-code injection used for that attempt.
- Archive artifacts and pending virtual-printer uploads can be saved to Files.
  Slicing an Archive artifact also saves the result in Files.
- Direct Queue uploads use hidden, temporary sources. They do not appear in
  Files and are retained while queued, active, or awaiting plate clear work needs them.
  Abandoned uploads are closed after 24 hours.
- Dispatch Archives link to their exact queue items through a nullable, unique
  database foreign key. Deleting a queue item clears the link and keeps the
  Archive history.
- G-code injection now wraps Grove snippets in markers. Every dispatch removes
  old Grove-marked snippets from Archive or Files copies; current snippets are
  added only when injection is enabled for that queue item.
- Added operator guidance for Files, Queue-only upload sources, and Archive
  attempts in [the workflow guide](docs/files-queue-archive.md).

### Changed

- Centralized existing Queue status changes behind a validated, conditional
  database update (issue #194, stage 1). Status names and workflows are unchanged;
  stale writes cannot overwrite a concurrent status change, and direct status
  assignments on stored queue rows are rejected. See the
  [transition guide](docs/queue-status-transitions.md).

- The virtual printer's former **Archive** mode now saves uploads to Files.
- `POST /api/v1/archives/upload` and `/api/v1/archives/upload-bulk` now return
  HTTP 410. Upload to Files to retain a file or to Queue to print it.
- Pending-upload `POST /api/v1/pending-uploads/{id}/archive` and
  `POST /api/v1/pending-uploads/archive-all` now return HTTP 410. Use
  `/{id}/save-to-files` and `/save-to-files-all` instead.
- The `library_archive_mode` setting and the public Queue
  `cleanup_library_after_dispatch` field were removed. Grove Control now
  manages temporary Queue source cleanup itself.

### Fixed

- The sidebar Queue badge, printer-card queue count, and printer health menu
  now include waiting jobs from the `queued` lifecycle.
- Normal Queue uploads no longer offer unconfirmed-dispatch actions before
  a command is sent. Archive and user-item deletion cannot bypass Clear Plate.
  Touchscreen prints on an uncleared printer take over its durable hold, and
  Clear Plate refuses to release a printer while a print is active.
- Interrupted heat soaks retry heater shutdown after reconnect until fresh
  telemetry confirms zero heater targets.
- Files bulk-queue submissions use the new `queued` lifecycle. Virtual-printer
  review uploads remain available for Save to Files.
- Queue-only uploads are excluded from automatic Files purging and serialize
  cleanup against queue submissions.

### Upgrade notes

- Stage 3 migrates Queue statuses once at startup and adds a unique printer
  reservation across every active and awaiting-plate-clear state. Existing
  plate holds remain actionable; unidentifiable legacy holds become external
  jobs. Back up the database before upgrading. Queued jobs targeting a deleted
  printer remain available to retarget. Waiting "Any machine" jobs that an
  older scheduler had assigned to a printer are returned to the pool.
- Integrations keep their existing names. Print completion notifications,
  webhooks, the MQTT relay and Home Assistant report the printer's outcome
  (`completed`, `failed`, `aborted`, or `cancelled` for a stop from Grove), and
  the webhook Queue status reports waiting jobs as `pending`. See the name
  table in [the lifecycle guide](docs/queue-status-transitions.md).

- The nullable Archive-to-queue link and unique index are added automatically
  at startup. Existing Archive rows keep a NULL link; no released database has
  dispatch-attempt links to backfill. No manual migration is required. Keep a
  backup until the upgraded service has started successfully.

## 1.0.0

Grove Control 1.0.0 is the stable release line.

### Upgrade notes

- Stable Docker images are published as `latest` and `1.0.0`; the stable tag
  has no `v` prefix.
- Development images use the separate `dev` tag and should not be used for
  production data.
- Existing Grove Control SQLite and PostgreSQL databases run the current
  schema migrations automatically on application startup.
- Create and download a backup before upgrading, and keep it until the new
  installation has been verified. Backups include the database and application
  data; explicitly configured environment secrets must be saved separately.

### Compatibility

- `TZ` defaults to `UTC` in Compose and in the application. Set an IANA timezone
  in the Docker Compose `.env`; source/native installs must export `TZ` in the
  process or service environment for local scheduled times such as scheduled
  backups.
- `DEBUG=false` is the safe default. Set it to `true` only for temporary
  diagnostics because it also enables SQLAlchemy engine logging; use
  `LOG_LEVEL=DEBUG` for application debug logs without SQL query echoing.
- BambuBuddy-to-Grove Control database conversion and queue-table rebuilding
  remain explicit, SQLite-only recovery operations. They are not part of a
  routine 1.0.0 upgrade and can discard transient queued/runtime state.
