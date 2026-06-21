# Grove Control

**Self-hosted print archive and management system for Bambu Lab 3D printers.**

No cloud dependency. Complete privacy. Full control.

## Quick Start

```bash
mkdir grove-control && cd grove-control
curl -O https://raw.githubusercontent.com/EdwardChamberlain/grove-control/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:8000** and add your printer.

> **Requirements:** Bambu Lab printer with Developer Mode enabled, on the same local network.

## Supported Architectures

| Architecture | Tag |
|---|---|
| x86-64 (Intel/AMD) | `amd64` |
| arm64 (Raspberry Pi 4/5) | `arm64` |

## Features

- **Real-Time Monitoring** — Live printer status, camera streaming, HMS error tracking (853 codes translated), resizable multi-printer dashboard
- **Print Archive** — Automatic 3MF archiving with metadata, interactive 3D model viewer (Three.js), photo attachments, failure analysis, side-by-side comparison
- **Print Scheduling** — Drag-and-drop queue, multi-printer assignment by model or location, time-based scheduling, re-print with AMS mapping
- **Smart Automation** — Smart plug control (Tasmota, Home Assistant, MQTT), auto power-on/off, energy monitoring, maintenance reminders
- **Proxy Mode** — Print remotely from Bambu Studio/OrcaSlicer without VPN or port forwarding, end-to-end TLS encrypted
- **Notifications** — WhatsApp, Telegram, Discord, Email, Pushover, ntfy with customizable templates and quiet hours
- **Projects** — Group related prints, track parts and plates, bill of materials, cost tracking, export as ZIP/JSON
- **File Manager** — Upload and organize sliced files, folder structure, print directly to any printer
- **Integrations** — Spoolman filament sync, MQTT publishing, Prometheus metrics, Bambu Cloud profiles, REST API, Home Assistant
- **Virtual Printer** — Appears in your slicer via SSDP discovery, multiple operating modes (archive, review, queue, proxy)
- **Security** — Optional authentication with group-based permissions (50+ granular), JWT tokens, API key support

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TZ` | `UTC` | Timezone (e.g. `America/New_York`, `Europe/Berlin`) |
| `PORT` | `8000` | Web UI port |
| `PUID` | `1000` | User ID for file permissions |
| `PGID` | `1000` | Group ID for file permissions |
| `DEBUG` | `false` | Enable debug logging |

## Volumes

| Path | Purpose |
|---|---|
| `/app/data` | Database, archived prints, thumbnails |
| `/app/logs` | Application logs |

## Docker Compose

```yaml
services:
  bambuddy:
    image: edchamberlain/grove-control:latest
    container_name: grove-control
    network_mode: host
    environment:
      - TZ=America/New_York
      - PUID=1000
      - PGID=1000
    volumes:
      - bambuddy_data:/app/data
      - bambuddy_logs:/app/logs
    restart: unless-stopped

volumes:
  bambuddy_data:
  bambuddy_logs:
```

> **macOS/Windows:** Docker Desktop doesn't support `network_mode: host`. Replace it with `ports: ["8000:8000"]` and add printers manually by IP.

## Updating

```bash
docker compose pull && docker compose up -d
```

## Development Builds

Development builds are published from the `dev` branch:

```bash
# Pull the current development build
docker pull edchamberlain/grove-control:dev
```

Use [Watchtower](https://containrrr.dev/watchtower/) to automatically update when new development builds are pushed.

> **Note:** Beta builds use version tags like `v0.2.2b1` — they are never tagged as `latest`. Your stable installation won't auto-update to a beta unless you explicitly pull a beta tag.

## Supported Printers

| Series | Models | Status |
|---|---|---|
| H2 | H2C, H2D, H2D Pro, H2S | Tested |
| X1 | X1 Carbon, X1E | Tested |
| P1 | P1P, P1S | Compatible |
| P2 | P2S | Compatible |
| A1 | A1, A1 Mini | Compatible |

All printers require **Developer Mode** enabled for LAN access.

## Links

- **Documentation:** [wiki.bambuddy.cool](http://wiki.bambuddy.cool)
- **GitHub:** [github.com/EdwardChamberlain/grove-control](https://github.com/EdwardChamberlain/grove-control)
- **Issues:** [GitHub Issues](https://github.com/EdwardChamberlain/grove-control/issues)

## License

MIT License - see [LICENSE](https://github.com/EdwardChamberlain/grove-control/blob/main/LICENSE) for details.
