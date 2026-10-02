# Updating Grove Control

This page covers upgrades to the stable Grove Control `1.0.0` release and
later. Docker Compose is the supported production install path.

## Release channels

- **Stable:** `ghcr.io/edwardchamberlain/grove-control:latest` follows the
  latest stable release. Pin the image to
  `ghcr.io/edwardchamberlain/grove-control:1.0.0` when you need a reproducible
  deployment. Stable tags use the bare `X.Y.Z` version; there is no `v` prefix.
- **Development:**
  `ghcr.io/edwardchamberlain/grove-control:dev` is built from the `dev` branch.
  It can change without notice and is intended for testing, not production
  data.
- **Source/native installations:** use the `main` branch for the stable
  source tree. The version in `VERSION` is the source-of-truth version; source
  installations do not use a GHCR image tag.

## Before you upgrade

1. In Grove Control, open **Settings → Backup** and use **Create Backup**.
   Download the ZIP and keep a copy outside the Docker volume or application
   directory until the upgraded installation has been verified.
2. If `MFA_ENCRYPTION_KEY` is set explicitly, save that secret separately.
   Auto-generated MFA keys are included in local backup ZIPs, but environment
   variables and external database credentials are not.
3. Make sure you have enough free disk space for the backup and the new image.

The complete local backup contains the database and application data such as
archives, virtual-printer data, plate-calibration data, icons, projects, and an
auto-generated MFA encryption key when present. Scheduled backups are optional;
they write to `DATA_DIR/backups` by default and should also be copied to storage
outside the host. `docker compose pull` and `docker compose up` do not create an
application backup automatically.

## Docker Compose upgrade

The repository Compose file tracks the stable `latest` image by default. To
pin an installation, edit the `image` line before pulling:

```yaml
image: ghcr.io/edwardchamberlain/grove-control:1.0.0
```

Then update and restart the service:

```bash
docker compose pull
docker compose up -d
docker compose logs --tail=100 grove-control
```

Do not use `docker compose down -v`: removing volumes deletes the persistent
database and application data. If your Compose file is old, download the
current file to a temporary name, compare it with your copy, and merge the
needed changes while preserving your volume and environment settings:

```bash
curl -fsSL https://raw.githubusercontent.com/EdwardChamberlain/grove-control/main/docker-compose.yml \
  -o docker-compose.yml.new
diff -u docker-compose.yml docker-compose.yml.new
```

For a locally built Docker image, update the stable source checkout first and
rebuild it:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
docker compose up -d --build
```

## Source/native upgrade

There is no separate native release package. A source installation is stable
when its checkout is on `main` and its `VERSION` file reports `1.0.0` (or the
later stable version being installed). Update the checkout, refresh Python or
Node dependencies if they changed, rebuild the frontend if the installation
serves compiled assets, and restart the application process or service:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
# Reinstall dependencies and rebuild/restart according to your service setup.
```

Use `dev` only for a development checkout. Do not point a production data
directory at an unreviewed development checkout without a current backup.

## Database migrations

Existing Grove Control databases are migrated automatically during application
startup. The startup path creates any missing tables, applies the idempotent
schema and data migrations for SQLite or PostgreSQL, and then starts the
background services. No separate migration command is required for a normal
`1.0.0` upgrade.

The Files and Archive workflow update adds a nullable, unique link from each
new dispatch-attempt Archive to its queue item. Existing Archive rows keep a
NULL link; no released database contains dispatch-attempt links to backfill.
Deleting a queue item clears its link and keeps the Archive history. No manual
database step is needed.

Keep the backup until the service starts successfully and you have checked the
printer list, archive, queue, and settings. If startup reports a migration
failure, stop the service, keep the original database and backup intact, and
review the logs before retrying. The `rebuild_database.py` and
`rebuild_print_queue.py` tools are recovery tools for specific legacy SQLite
problems, not routine upgrade steps; see the recovery notes in
[`README.md`](README.md).

An older SQLite installation that has only `bambutrack.db` is renamed to
`bambuddy.db` automatically on startup when the new filename does not already
exist. Back up the data directory before starting that upgrade.

## Files, Queue, and Archive workflow changes

Each print that reaches dispatch, including a reprint, now creates its own
Archive entry containing the exact file sent to the printer. Direct Queue
uploads are held as temporary sources and no longer appear in Files. Use
**Save to Files** on an Archive or pending virtual-printer upload when the
file should be kept in the user-managed library. The virtual printer's former
**Archive** mode now saves to Files.

API clients should replace `POST /api/v1/archives/upload` and
`POST /api/v1/archives/upload-bulk` with Files or Queue uploads; both old
Archive routes return HTTP 410. Pending-upload routes
`POST /api/v1/pending-uploads/{id}/archive` and
`POST /api/v1/pending-uploads/archive-all` also return HTTP 410. Replace them
with `POST /api/v1/pending-uploads/{id}/save-to-files` and
`POST /api/v1/pending-uploads/save-to-files-all`.

The `library_archive_mode` setting has been removed. Queue-create requests and
responses no longer have the `cleanup_library_after_dispatch` field; the
server derives cleanup from whether the source is a hidden Queue upload.

## Queue job identity (stage 2)

No schema migration is required. Printer events now need a matching submission
ID; legacy active jobs without one remain in place until resolved by the user.
The Queue offers **It's printing** / **It didn't start** for unconfirmed
dispatches after 270 seconds. Inspect the physical printer before choosing.
Interrupted heat soaks remain reserved with Stop and Skip controls. Local prints
that report no firmware ID cannot be reattached automatically after reconnect
or restart. Use Stop to resolve an old active reservation when necessary.
See [Queue job identity](docs/queue-job-identity.md) for details and the required
hardware validation. Status names sent to integrations remain unchanged.

## Queue pause and resume (stage 4)

No additional migration is needed after stage 3: `paused` is already included
in its versioned lifecycle and printer holding index. The next fresh, matching
PAUSE observation changes an active job to Paused; matching RUNNING telemetry
returns it to Printing. Existing ambiguous or offline jobs stay where they are,
with Stop available. Inspect the printer before resolving them.

Queue REST clients now receive `paused`. The webhook Queue view continues to
report `printing` for paused jobs and includes them in its printing count;
the existing Prometheus queue printing gauge does the same. Pause/resume does
not create another Archive or change its physical outcome. See the
[lifecycle guide and stage 4 hardware checklist](docs/queue-status-transitions.md).

## Queue Archive alignment (stage 5)

The upgrade adds nullable physical-outcome fields to Queue jobs and backfills
known outcomes once, controlled by `queue_archive_outcome_version = 1`.
An exact Archive/job link or an unambiguous terminal job state supplies the
backfill; an older `unsuccessful` job without that evidence stays unknown.
Display reasons are never used to guess whether a print failed or was stopped.

New attempts create their exact Archive copy atomically with entry into
Dispatching, before uploading to the printer. An upload or command failure
therefore appears in Archive while its
job holds the printer on the Queue. Jobs cancelled while waiting, or stopped
or failed during preheating, still create no Archive entry.

Archive outcomes commit when jobs enter Finished, Failed, or Cancelled.
Clear Plate changes only the job. Existing Archive outcome names remain
`completed`, `failed`, and `aborted`, including for paused and external jobs.
An external Archive download that finishes after Clear Plate uses the retained
physical outcome, timestamp and failure reason. Copy failures also honor the
job's Auto Off setting, including completed and skipped heat-soak handoffs.
Heat-soak handoffs check current telemetry after copying, including when a
reconnection replaces the client. Retry starts with empty physical-outcome
fields; cancelling the retry while queued does not inherit the old result.
Hidden Queue uploads remain available while any nonfinal job references them,
including a queued file variant; deletion happens after the last job finalizes
and its transaction commits. Files copies remain independent.

Existing active attempts retain their Archive and use the normal identity
checks. An older in-flight upload with no attempt Archive remains held for
inspection and Retry rather than sending without an Archive. Review the
[stage 5 qualification checklist](docs/queue-status-transitions.md).

## Timezone

`TZ` is the authoritative timezone for the container and for scheduled local
times such as local backup schedules. Grove Control stores database timestamps
in UTC and converts them for local display. The Compose default and the
application fallback are both `UTC`. For Docker Compose, set an IANA timezone
in `.env` or in the container environment when a different local timezone is
required:

```dotenv
TZ=Europe/London
```

For a source/native installation, export `TZ` in the shell or service
environment before starting Grove Control; setting it only in `.env` is not
sufficient for the native process:

```bash
export TZ=Europe/London
```

The installer scripts detect the host timezone when possible and write it to
`.env`; pass `--tz` or `-TimeZone` to override the detected value.
