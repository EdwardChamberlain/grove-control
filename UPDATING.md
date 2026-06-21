# Updating Grove Control

```bash
# 1. Make sure your compose file isn't pinned to an old version.
#    The image line should read one of:
#      image: ghcr.io/maziggy/bambuddy:latest
#      image: ghcr.io/maziggy/bambuddy:0.2.3
#    If it pins an older tag (e.g. :0.2.2.2), edit it first.

# 2. Pull and restart
docker compose pull
docker compose up -d
```

**If your `docker-compose.yml` is older than 0.2.3,** also refresh it from the
repo — recent releases added `cap_add: NET_BIND_SERVICE`, extra virtual-printer
ports for bridge mode, and an optional Postgres block:

```bash
curl -fsSL https://raw.githubusercontent.com/maziggy/bambuddy/main/docker-compose.yml \
  -o docker-compose.yml.new
# Diff against yours, merge by hand, then:
docker compose up -d
```

## Before you upgrade

Take a backup. Settings → Backup → **Create Backup** downloads a ZIP containing
the database and all stateful directories. Docker Compose upgrades do not create
an automatic application backup.
