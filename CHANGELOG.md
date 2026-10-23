# Changelog

## Unreleased

- Remove the retired `POST /archives/{id}/reprint` endpoint, which only returned
  `410 Gone`. Reprint an archive by creating a queue item with `POST /queue/`;
  nothing in the frontend called the old route (#193).
- Restore the print workflow from `ee00437`, retaining queue-item retargeting
  (#186), direct Queue upload (#188), frontend dependency security fixes
  (#210), live Print/Queue labels (#213), and count-based Archive retention
  (#199). The Files/Archive split (#189) and subsequent lifecycle changes are
  excluded from this candidate.
- Keep the existing Queue history, pending/skipped states, configured print
  Auto Off cooldowns, and interrupted heat-soak shutdown recovery.
- Archive retention protects waiting/active reprint sources and the persisted
  plate-clear Archive. Count-policy changes require an explicit Apply after
  preview; age-based retention remains the default.
- Data migrated by the withdrawn development lifecycle is not downgraded.
  Use a fresh test database or a compatible backup; see UPDATING.md.

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
