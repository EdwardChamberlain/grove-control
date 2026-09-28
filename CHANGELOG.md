# Changelog

## Unreleased

### Added

- Every Queue dispatch, including a reprint, creates its own Archive attempt.
  It records the print outcome and stores the exact file uploaded to the
  printer, including any G-code injection used for that attempt.
- Archive artifacts and pending virtual-printer uploads can be saved to Files.
  Slicing an Archive artifact also saves the result in Files.
- Direct Queue uploads use hidden, temporary sources. They do not appear in
  Files and are retained while queued, skipped, or retryable work needs them.
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
  stale writes cannot overwrite a concurrent status change. See the
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

- Queue-only uploads are excluded from automatic Files purging and serialize
  cleanup against queue submissions.

### Upgrade notes

- Queue transition centralization requires no schema migration or manual action.

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
