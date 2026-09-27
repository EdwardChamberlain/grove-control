# Changelog

## Unreleased

### Added

- Queue dispatches now create an Archive attempt linked to its queue item by a
  unique database foreign key. Existing unambiguous links are backfilled during
  startup migration, and deleting a queue item clears the link while retaining
  the Archive history.
- G-code injection now wraps Grove snippets in markers. Reprinting an archived
  snapshot removes old Grove-marked snippets before applying the current
  settings, so each snippet runs once and the saved snapshot remains unchanged.
- Added operator guidance for Files, Queue-only upload sources, and Archive
  attempts in [the workflow guide](docs/files-queue-archive.md).

### Fixed

- Queue-only uploads are excluded from automatic Files purging and serialize
  cleanup against queue submissions.

### Upgrade notes

- The new nullable Archive-to-queue link is added and safely backfilled
  automatically at startup for existing databases. No manual migration is
  required; keep a backup until the upgraded service has started successfully.

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
