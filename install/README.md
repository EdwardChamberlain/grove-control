# Grove Control Docker Install Scripts

Docker Compose is the supported production install path.

This directory contains convenience scripts for Docker-based installs only.
They download the project `docker-compose.yml`, apply the requested port and
timezone settings, and start Grove Control with Docker Compose.

## Quick Start

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/EdwardChamberlain/grove-control/main/install/docker-install.sh -o docker-install.sh
chmod +x docker-install.sh
./docker-install.sh
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/EdwardChamberlain/grove-control/main/install/docker-install.sh -o docker-install.sh
chmod +x docker-install.sh
./docker-install.sh
```

Docker Desktop does not support Linux host networking. The script rewrites the
compose file to use port mappings instead. Printer auto-discovery is unavailable
in Docker Desktop, so add printers manually by IP.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/EdwardChamberlain/grove-control/main/install/docker-install.ps1 -OutFile docker-install.ps1; .\docker-install.ps1"
```

Docker Desktop must be installed and running. Printer auto-discovery is
unavailable in Docker Desktop, so add printers manually by IP.

## Scripts

| Script | Platform | Purpose |
|--------|----------|---------|
| `docker-install.sh` | Linux, macOS | Docker Compose install helper |
| `docker-install.ps1` | Windows | Docker Desktop install helper |

## `docker-install.sh`

Options:

```text
--path PATH        Installation directory (default: /opt/bambuddy)
--port PORT        Port to expose (default: 8000)
--tz TIMEZONE      Timezone (default: system timezone or UTC)
--build            Build the Docker image locally instead of using the pre-built image
--yes, -y          Non-interactive mode, accept defaults
--help, -h         Show help
```

Examples:

```bash
./docker-install.sh
./docker-install.sh --path /srv/bambuddy --port 3000 --tz Europe/Berlin --yes
./docker-install.sh --build --yes
```

## `docker-install.ps1`

Parameters:

```text
-InstallPath PATH    Installation directory (default: %USERPROFILE%\bambuddy)
-Port PORT           Port to expose (default: 8000)
-TimeZone TZ         IANA timezone (default: derived from Get-TimeZone or UTC)
-Build               Build the Docker image locally instead of pulling the pre-built image
-Yes                 Non-interactive mode, accept defaults
-Help                Show help
```

Examples:

```powershell
.\docker-install.ps1
.\docker-install.ps1 -InstallPath C:\bambuddy -Port 8080 -TimeZone Europe/Berlin -Yes
.\docker-install.ps1 -Build -Yes
```

## Updating

```bash
cd /path/to/bambuddy
docker compose pull
docker compose up -d
```

If you use a locally built Docker image with `--build`, update the checkout first and
rebuild:

```bash
cd /path/to/bambuddy
git pull
docker compose up -d --build
```

## Service Management

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down
docker compose up -d
```

## Requirements

- Docker Engine 20+ with Docker Compose, or Docker Desktop on macOS/Windows
- About 1 GB of disk space for the image and runtime data

## Support

- Documentation: https://wiki.bambuddy.cool
- Issues: https://github.com/EdwardChamberlain/grove-control/issues
