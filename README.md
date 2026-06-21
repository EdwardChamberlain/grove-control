<p align="center">
  <img src="static/img/grove_control_logo_dark.png" alt="Grove Control Logo" width="300">
</p>

<p align="center">
  <strong>Your printers. Your rules.</strong><br>
  Self-hosted control center for Bambu Lab printers
</p>

## Why Grove Control?

- **Local-first by design**: Keep control of your printers, jobs, and production data on your own network.
- **Own your workflow**: Schedule prints, manage queues, control smart sockets, and automate routine production tasks.
- **Fleet management built in**: Monitor and manage multiple printers from a single interface designed for busy workshops and print farms.

---

## ✨ Features

Grove Control brings together printer monitoring, scheduling, automation, and production management in one local-first interface.

### Core Features

- **Printer monitoring and control**: View live printer status, camera feeds, temperatures, fan states, AMS data, HMS errors, and job progress from a central dashboard.
- **Production scheduling**: Queue, schedule, and dispatch prints across multiple printers with support for batch jobs, model-based assignment, filament validation, and clear-plate workflows.
- **Print archive and history**: Automatically archive completed prints with metadata, thumbnails, reprint support, print logs, cost tracking, and failure history.
- **Multi-printer fleet management**: Manage multiple Bambu Lab printers from one interface, with filtering, search, bulk actions, and per-printer configuration.
- **File and project management**: Organise sliced files, library folders, MakerWorld imports, project groups, plates, parts, and related print assets.
- **Spool and filament tracking**: Track spool inventory, AMS assignments, filament usage, remaining weight, material profiles, costs, and low-stock alerts.
- **Automation and smart power control**: Integrate smart plugs, automate printer power, track energy usage, manage drying workflows, and reduce manual intervention.
- **Notifications and alerts**: Send print events, errors, queue updates, plate detection warnings, and completion alerts through services such as Discord, Telegram, WhatsApp, email, ntfy, Pushover, Home Assistant, and webhooks.
- **Virtual printer and remote workflows**: Send jobs from Bambu Studio or OrcaSlicer into Grove Control using virtual printer modes for archiving, review, queueing, or proxy printing.
- **Integrations and extensibility**: Supports MQTT, Home Assistant, Prometheus, Spoolman, webhooks, API keys, local profiles, cloud profile sync, and backup workflows.
- **Optional authentication**: Add user accounts, permissions, activity tracking, API protection, SSO, 2FA, and per-user notification settings when needed.
- **Maintenance and diagnostics**: Track maintenance intervals, view logs, generate support bundles, monitor firmware versions, and access diagnostic tools.

For detailed feature documentation, see the project documentation.

---

## 📸 Screenshots

<details>
<summary><strong>Click to expand screenshots</strong></summary>

<p align="center">
  <img src="docs/screenshots/printers.png" alt="Printers" width="800">
  <br><em>Real-time printer monitoring with AMS status</em>
</p>

<p align="center">
  <img src="docs/screenshots/archives.png" alt="Archives" width="800">
  <br><em>Print archive with 3D preview and project assignment</em>
</p>

<p align="center">
  <img src="docs/screenshots/reprint_ams_mapping.png" alt="Reprint AMS Mapping" width="800">
  <br><em>Re-print with AMS filament mapping preview</em>
</p>

<p align="center">
  <img src="docs/screenshots/edit-timelapse.png" alt="Timelapse Editor" width="800">
  <br><em>Built-in timelapse editor with trim, speed, and music</em>
</p>

<p align="center">
  <img src="docs/screenshots/projects.png" alt="Projects" width="800">
  <br><em>Group related prints into projects</em>
</p>

<p align="center">
  <img src="docs/screenshots/project-detail-1.png" alt="Project Detail" width="800">
  <br><em>Project detail view with assigned archives</em>
</p>

<p align="center">
  <img src="docs/screenshots/project-detail-2.png" alt="Project Detail Timeline" width="800">
  <br><em>Project timeline and print history</em>
</p>

<p align="center">
  <img src="docs/screenshots/print-queue.png" alt="Queue" width="800">
  <br><em>Print scheduling and queue management</em>
</p>

<p align="center">
  <img src="docs/screenshots/schedule-print.png" alt="Schedule Print" width="800">
  <br><em>Schedule prints for specific date and time</em>
</p>

<p align="center">
  <img src="docs/screenshots/statistics.png" alt="Statistics" width="800">
  <br><em>Customizable statistics dashboard</em>
</p>

<p align="center">
  <img src="docs/screenshots/maintenance-1.png" alt="Maintenance" width="800">
  <br><em>Maintenance tracking per printer</em>
</p>

<p align="center">
  <img src="docs/screenshots/maintenance-2.png" alt="Maintenance Settings" width="800">
  <br><em>Configure maintenance types and intervals</em>
</p>

<p align="center">
  <img src="docs/screenshots/cloud_profiles-1.png" alt="Cloud Profiles" width="800">
  <br><em>Bambu Cloud filament profiles</em>
</p>

<p align="center">
  <img src="docs/screenshots/cloud_profiles-2.png" alt="Cloud Profiles Edit" width="800">
  <br><em>Edit filament preset settings</em>
</p>

<p align="center">
  <img src="docs/screenshots/k_profiles-1.png" alt="K-Profiles" width="800">
  <br><em>Pressure advance (K-factor) profiles</em>
</p>

<p align="center">
  <img src="docs/screenshots/k_profiles-2.png" alt="K-Profiles Edit" width="800">
  <br><em>Edit K-factor profile settings</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings-general.png" alt="Settings" width="800">
  <br><em>General configuration and integrations</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings-powerplugs.png" alt="Smart Plugs" width="800">
  <br><em>Smart plug control and energy monitoring</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings_notifications.png" alt="Notifications" width="800">
  <br><em>Multi-provider notification system</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings_api_keys.png" alt="API Keys" width="800">
  <br><em>API keys and webhook endpoints</em>
</p>

<p align="center">
  <img src="docs/screenshots/settings-virtual-printer.png" alt="Virtual Printer Settings" width="800">
  <br><em>Virtual printer configuration</em>
</p>

<p align="center">
  <img src="docs/screenshots/slicer-virtual-printer.png" alt="Slicer Virtual Printer" width="800">
  <br><em>Virtual printer appears in Bambu Studio/Orca Slicer</em>
</p>

<p align="center">
  <img src="docs/screenshots/mqtt-debug-log.png" alt="MQTT Debug Log" width="800">
  <br><em>MQTT debug logging for troubleshooting</em>
</p>

<p align="center">
  <img src="docs/screenshots/quick_power_plug_sidebar.png" alt="Quick Power Plug" width="400">
  <br><em>Quick power plug control in sidebar</em>
</p>

</details>

---

## 🚀 Quick Start

### Requirements
- Docker Engine 20+ with Docker Compose, or Docker Desktop on macOS/Windows
- Bambu Lab printer with **Developer Mode** enabled (see below)
- **"Store sent files on external storage"** enabled in Bambu Studio/OrcaSlicer
- Same local network as printer

### Installation

> **Supported install path:** Docker Compose is the supported production install path.

#### Docker Compose

**Option A: Pre-built image (fastest)**
```bash
mkdir bambuddy && cd bambuddy
curl -O https://raw.githubusercontent.com/maziggy/bambuddy/main/docker-compose.yml
docker compose up -d
```

**Option B: Build the Docker image locally**
```bash
git clone https://github.com/maziggy/bambuddy.git
cd bambuddy
docker compose up -d --build
```

Open **http://localhost:8000** in your browser.

> **Multi-architecture support:** Pre-built images are available for `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5).

> **macOS/Windows users:** Docker Desktop doesn't support `network_mode: host`. Edit docker-compose.yml: comment out `network_mode: host` and uncomment the `ports:` section. Printer discovery won't work - add printers manually by IP.

> **Linux users:** If you get "permission denied" errors, either prefix commands with `sudo` (e.g., `sudo docker compose up -d`) or [add your user to the docker group](https://docs.docker.com/engine/install/linux-postinstall/).

<details>
<summary><strong>Docker Configuration & Commands</strong></summary>

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `UTC` | Your timezone (e.g., `America/New_York`, `Europe/Berlin`) |
| `PORT` | `8000` | Port BamBuddy runs on (with host networking mode) |
| `DEBUG` | `false` | Enable debug logging |
| `LOG_LEVEL` | `INFO` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |

**Data Persistence:**

| Volume | Purpose |
|--------|---------|
| `bambuddy.db` | SQLite database with all your print data (not used with PostgreSQL) |
| `archive/` | Archived 3MF files and thumbnails |
| `logs/` | Application logs |

**Updating:**

```bash
# Pre-built image: just pull the latest
docker compose pull && docker compose up -d

# Locally built image: rebuild after pulling changes
cd bambuddy && git pull && docker compose up -d --build
```

**Daily Beta Builds:**

Beta builds with the latest fixes are pushed regularly to the same beta version tag:

```bash
# Pull the current beta
docker pull ghcr.io/maziggy/bambuddy:0.2.2b1
# or from Docker Hub
docker pull maziggy/bambuddy:0.2.2b1
```

Use [Watchtower](https://containrrr.dev/watchtower/) to automatically update when new daily builds are pushed.

> **Note:** Beta builds use version tags like `0.2.2b1` — they are never tagged as `latest`. Your stable installation won't auto-update to a beta unless you explicitly pull a beta tag.

**Useful Commands:**

```bash
# View logs
docker compose logs -f

# Stop/Start
docker compose down
docker compose up -d

# Shell access
docker compose exec bambuddy /bin/bash
```

**Custom Port:**

```yaml
ports:
  - "3000:8000"  # Access on port 3000
```

**Reverse Proxy (Nginx):**

```nginx
server {
    listen 443 ssl http2;
    server_name bambuddy.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

> **Note:** WebSocket support is required for real-time printer updates.

**Network Mode Host** (required for printer discovery and camera streaming):

```yaml
services:
  bambuddy:
    build: .
    network_mode: host
```

> **Note:** Docker's default bridge networking cannot receive SSDP multicast packets for automatic printer discovery. When using `network_mode: host`, Grove Control auto-detects your network subnet and can discover printers via subnet scanning in the Add Printer dialog.

</details>

### Enabling Developer Mode

Developer Mode allows third-party software like Grove Control to control your printer over the local network.

1. On printer: **Settings** → **Network** → **LAN Only Mode** → Enable
2. Enable **Developer Mode** (appears after LAN Only Mode is enabled)
3. Note the **Access Code** displayed
4. Find IP address in network settings
5. Find Serial Number in device info

> **Note:** Developer Mode disables cloud features but provides full local control. Standard LAN Mode (without Developer Mode) only allows read-only monitoring.

### Slicer Settings

In Bambu Studio or OrcaSlicer, enable **"Store sent files on external storage"** so that print files (3MF) are saved to the printer's SD card. Grove Control needs these files to extract thumbnails and 3D model previews.

1. Open **Bambu Studio** or **OrcaSlicer**
2. Go to the **Device** tab for your printer
3. In **Print Options**, enable **Store Sent Files on External Storage**

---

## 📚 Documentation

Full documentation available at **[wiki.bambuddy.cool](http://wiki.bambuddy.cool)**:

- [Installation](http://wiki.bambuddy.cool/getting-started/installation/) — Docker Compose setup
- [Getting Started](http://wiki.bambuddy.cool/getting-started/) — First printer setup
- [Features](http://wiki.bambuddy.cool/features/) — Detailed feature guides
- [Troubleshooting](http://wiki.bambuddy.cool/reference/troubleshooting/) — Common issues & solutions
- [API Reference](http://wiki.bambuddy.cool/reference/api/) — REST API documentation

---

## 🖨️ Supported Printers

| Series | Models |
|--------|--------|
| X1 | X1, X1 Carbon, X1E |
| X2 | X2D |
| H2 | H2D, H2D Pro, H2C, H2S |
| P1 | P1P, P1S |
| P2 | P2S |
| A1 | A1, A1 Mini |
| A2 | A2L |

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Python, FastAPI, SQLAlchemy |
| Frontend | React, TypeScript, Tailwind CSS |
| Database | SQLite (default) or PostgreSQL |
| 3D Viewer | Three.js |
| Communication | MQTT (TLS), FTPS |

---

## 🤝 Contributing

Contributions welcome! Ways to help:

1. **📝 Document** — Improve the wiki and guides
2. **Test** — Report issues with your printer model
3. **Translate** — Add new languages
4. **Code** — Submit PRs for bugs or features

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## 📄 License

AGPL-3.0 License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [Bambuddy](https://bambuddy.cool) by MartinNYHC — Grove Control is built on and forked from the Bambuddy project, and owes a great deal to the strong foundation and awesome work behind it.
- [Bambu Lab](https://bambulab.com/) for amazing printers
- The reverse engineering community for protocol documentation
- All testers and contributors

---

<p align="center">
  Made with ❤️ for the 3D printing community
</p>
