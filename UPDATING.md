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
