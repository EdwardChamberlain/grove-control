"""Update checking and management routes."""

import asyncio
import base64
import logging
import os
import re
import shutil
import sys
import time

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.config import APP_VERSION, GITHUB_BRANCH, GITHUB_REPO, settings
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.settings import Settings
from backend.app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/updates", tags=["updates"])

# Global state for update progress
_update_status = {
    "status": "idle",  # idle, checking, downloading, installing, complete, error
    "progress": 0,
    "message": "",
    "error": None,
}

# GitHub rate-limit backoff (#1420): when api.github.com returns 403 with
# X-RateLimit-Remaining=0, refuse to retry until X-RateLimit-Reset (epoch
# seconds). Falls back to a 1-hour pause if the header is absent. Prevents
# the update checker from hammering GitHub once the unauthenticated quota
# (60 req/hr per source IP) is exhausted.
_GITHUB_RATE_LIMIT_FALLBACK_SECONDS = 3600
_github_rate_limit_until: float = 0.0


def _seconds_until_github_unblocked() -> float:
    """Return seconds remaining until GitHub backoff lifts, or 0 if unblocked."""
    remaining = _github_rate_limit_until - time.time()
    return remaining if remaining > 0 else 0.0


def _record_github_rate_limit(response: httpx.Response) -> None:
    """Set the backoff window from a GitHub 403 response's headers."""
    global _github_rate_limit_until
    reset_header = response.headers.get("X-RateLimit-Reset")
    reset_at: float | None = None
    if reset_header:
        try:
            reset_at = float(reset_header)
        except ValueError:
            reset_at = None
    if reset_at is None:
        reset_at = time.time() + _GITHUB_RATE_LIMIT_FALLBACK_SECONDS
    # Floor at a 60s minimum: protects against clock skew between the container
    # and GitHub (parsed reset epoch in the past would otherwise leave us with
    # no real backoff and we'd hammer GitHub again immediately).
    reset_at = max(reset_at, time.time() + 60)
    # Only extend the window — never shorten it via an out-of-order response.
    if reset_at > _github_rate_limit_until:
        _github_rate_limit_until = reset_at
    logger.warning(
        "GitHub rate limit hit; suppressing update checks for %.0fs (reset header=%s)",
        _seconds_until_github_unblocked(),
        reset_header,
    )


def _is_github_rate_limit_response(response: httpx.Response) -> bool:
    """Detect a rate-limit response from GitHub (403/429 with Remaining=0)."""
    if response.status_code not in (403, 429):
        return False
    remaining = response.headers.get("X-RateLimit-Remaining")
    if remaining == "0":
        return True
    # Some proxies strip the header; fall back to body inspection.
    try:
        body = response.text or ""
    except Exception:
        body = ""
    return "rate limit" in body.lower() or "API rate limit exceeded" in body


def _is_docker_environment() -> bool:
    """Detect if running inside a Docker container."""
    if os.path.exists("/.dockerenv"):
        return True
    try:
        with open("/proc/1/cgroup") as f:
            if "docker" in f.read():
                return True
    except (FileNotFoundError, PermissionError):
        pass  # cgroup file unavailable; continue with other detection methods
    # Check container runtime hint (systemd sets this for Docker/podman,
    # but NOT for LXC/LXD — avoids false positives on Proxmox containers)
    try:
        with open("/run/systemd/container") as f:
            runtime = f.read().strip()
            if runtime in ("docker", "podman", "oci"):
                return True
    except (FileNotFoundError, PermissionError):
        pass
    return False


def _is_ha_addon() -> bool:
    """Detect if running as a Home Assistant Supervisor addon.

    HA Supervisor injects ``SUPERVISOR_TOKEN`` into every addon container;
    the variable is not set in any other environment, so a single env-var
    check is sufficient with no false-positive surface.
    """
    return bool(os.environ.get("SUPERVISOR_TOKEN"))


def _find_executable(name: str) -> str | None:
    """Find an executable in PATH or common locations."""
    # Try standard PATH first
    path = shutil.which(name)
    if path:
        return path

    # Common locations for executables (useful when running as systemd service)
    common_paths = [
        f"/usr/bin/{name}",
        f"/usr/local/bin/{name}",
        f"/opt/homebrew/bin/{name}",
        f"/home/linuxbrew/.linuxbrew/bin/{name}",
        f"{os.path.expanduser('~')}/.nvm/current/bin/{name}",
        f"{os.path.expanduser('~')}/.local/bin/{name}",
    ]

    for p in common_paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p

    return None


def _parse_github_remote(url: str) -> tuple[str, str] | None:
    """Extract `(owner, repo)` from a GitHub remote URL, or None if it isn't a
    GitHub URL we recognise.

    Handles the four forms `git remote -v` typically prints:
      - `git@github.com:owner/repo.git`         (SSH, the dev default)
      - `git@github.com:owner/repo`             (SSH without .git suffix)
      - `https://github.com/owner/repo.git`     (HTTPS, what _perform_update sets)
      - `https://github.com/owner/repo`         (HTTPS without .git)

    Anything else (a fork URL, a different host, a malformed value, the empty
    string from a missing origin) returns None so the caller treats it as
    "not pointing at our repo" and resets it.
    """
    s = url.strip()
    if not s:
        return None
    # SSH form: git@github.com:owner/repo[.git]
    ssh_prefix = "git@github.com:"
    https_prefix_a = "https://github.com/"
    https_prefix_b = "http://github.com/"  # tolerated for legacy
    if s.startswith(ssh_prefix):
        path = s[len(ssh_prefix) :]
    elif s.startswith(https_prefix_a):
        path = s[len(https_prefix_a) :]
    elif s.startswith(https_prefix_b):
        path = s[len(https_prefix_b) :]
    else:
        return None
    if path.endswith(".git"):
        path = path[:-4]
    parts = path.strip("/").split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return (parts[0], parts[1])


async def _origin_points_at_repo(git_path: str, git_config: list[str], app_dir, expected_repo: str) -> bool:
    """Return True iff the working tree's `origin` already resolves to
    `<owner>/<repo>` matching `expected_repo` (e.g. "EdwardChamberlain/grove-control"),
    regardless of whether it's the SSH or HTTPS form. Used to skip the
    `git remote set-url origin https://...` rewrite when the developer's
    SSH origin is already correct — see `_perform_update` for context.

    ``app_dir`` is the working tree (where ``.git`` lives), not the data
    dir — see #1715 for the separate-mount layout that proved why this
    must NOT be ``base_dir``."""
    try:
        process = await asyncio.create_subprocess_exec(
            git_path,
            *git_config,
            "remote",
            "get-url",
            "origin",
            cwd=str(app_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await process.communicate()
    except (OSError, asyncio.CancelledError):
        # Fail closed: let the caller go through the rewrite branch if we
        # can't even invoke git. The unconditional set-url is the safer
        # fallback, only mildly destructive.
        return False
    if process.returncode != 0:
        # Most likely cause: no `origin` defined yet (fresh clone-style
        # checkout). Caller will set it.
        return False
    parsed = _parse_github_remote(stdout.decode().strip())
    if parsed is None:
        return False
    owner, repo = parsed
    expected_owner, expected_repo_name = expected_repo.split("/", 1)
    return owner == expected_owner and repo == expected_repo_name


def parse_version(version: str) -> tuple:
    """Parse version string into tuple for comparison.

    Returns (major, minor, patch, micro, is_prerelease, prerelease_num)
    where is_prerelease is 0 for release, 1 for prerelease.
    This ensures releases sort higher than prereleases of same version.

    Examples:
        "0.1.5"    -> (0, 1, 5, 0, 0, 0)   # release
        "0.1.5b7"  -> (0, 1, 5, 0, 1, 7)   # beta 7
        "0.1.5b10" -> (0, 1, 5, 0, 1, 10)  # beta 10
        "0.1.8.1"  -> (0, 1, 8, 1, 0, 0)   # patch release
    """
    # Remove 'v' prefix if present
    version = version.lstrip("v")

    # Strip daily build suffix (e.g., "0.2.2b4-daily.20260313" -> "0.2.2b4")
    version = re.sub(r"-daily\.\d+$", "", version)

    # Match version pattern: major.minor.patch[.micro][b|beta|alpha|rc]N
    match = re.match(r"(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:b|beta|alpha|rc)?(\d+)?", version)

    if match:
        major = int(match.group(1))
        minor = int(match.group(2))
        patch = int(match.group(3))
        micro = int(match.group(4)) if match.group(4) else 0
        prerelease_num = int(match.group(5)) if match.group(5) else 0

        # Check if this is a prerelease (has b/beta/alpha/rc/daily suffix anywhere)
        is_prerelease = 1 if re.search(r"[a-zA-Z]", version) else 0

        return (major, minor, patch, micro, is_prerelease, prerelease_num)

    # Fallback: try simple split
    parts = []
    for part in version.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            num = "".join(c for c in part if c.isdigit())
            parts.append(int(num) if num else 0)

    return tuple(parts) + (0, 0, 0)


def is_newer_version(latest: str, current: str) -> bool:
    """Check if latest version is newer than current.

    Properly handles prerelease versions:
    - 0.1.5 > 0.1.5b7 (release is newer than any beta)
    - 0.1.5b8 > 0.1.5b7 (later beta is newer)
    - 0.1.6b1 > 0.1.5 (next version beta is newer than current release)
    """
    try:
        latest_parsed = parse_version(latest)
        current_parsed = parse_version(current)

        # Compare (major, minor, patch, micro) first
        latest_base = latest_parsed[:4]
        current_base = current_parsed[:4]

        if latest_base > current_base:
            return True
        elif latest_base < current_base:
            return False

        # Same base version - compare prerelease status
        # is_prerelease: 0 = release, 1 = prerelease
        # Release (0) should be "greater" than prerelease (1)
        latest_is_prerelease = latest_parsed[4] if len(latest_parsed) > 4 else 0
        current_is_prerelease = current_parsed[4] if len(current_parsed) > 4 else 0

        if latest_is_prerelease < current_is_prerelease:
            # latest is release, current is prerelease -> latest is newer
            return True
        elif latest_is_prerelease > current_is_prerelease:
            # latest is prerelease, current is release -> latest is NOT newer
            return False

        # Both are same type (both release or both prerelease)
        # Compare prerelease numbers
        latest_prerelease_num = latest_parsed[5] if len(latest_parsed) > 5 else 0
        current_prerelease_num = current_parsed[5] if len(current_parsed) > 5 else 0

        return latest_prerelease_num > current_prerelease_num

    except Exception:
        return False


@router.get("/version")
async def get_version():
    """Get current application version.

    Note: Unauthenticated - needed to display version in UI without login.
    """
    return {
        "version": APP_VERSION,
        "repo": GITHUB_REPO,
        "branch": GITHUB_BRANCH,
    }


@router.get("/check")
async def check_for_updates(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SYSTEM_READ),
):
    """Check GitHub for available updates."""
    global _update_status

    # Respect the check_updates setting
    result = await db.execute(select(Settings).where(Settings.key == "check_updates"))
    setting = result.scalar_one_or_none()
    if setting and setting.value.lower() == "false":
        return {
            "update_available": False,
            "current_version": APP_VERSION,
            "latest_version": None,
            "message": "Update checks are disabled",
        }

    # Short-circuit if we're still inside a GitHub rate-limit backoff window (#1420).
    backoff_remaining = _seconds_until_github_unblocked()
    if backoff_remaining > 0:
        _update_status = {
            "status": "error",
            "progress": 0,
            "message": "GitHub rate limit reached",
            "error": "GitHub rate limit reached; retry later",
        }
        return {
            "update_available": False,
            "current_version": APP_VERSION,
            "latest_version": None,
            "error": "GitHub rate limit reached; retry later",
            "retry_after_seconds": int(backoff_remaining),
        }

    _update_status = {
        "status": "checking",
        "progress": 0,
        "message": "Checking for updates...",
        "error": None,
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://api.github.com/repos/{GITHUB_REPO}/contents/VERSION?ref={GITHUB_BRANCH}",
                headers={"Accept": "application/vnd.github.v3+json"},
                timeout=10.0,
            )

            if _is_github_rate_limit_response(response):
                _record_github_rate_limit(response)
                _update_status = {
                    "status": "error",
                    "progress": 0,
                    "message": "GitHub rate limit reached",
                    "error": "GitHub rate limit reached; retry later",
                }
                return {
                    "update_available": False,
                    "current_version": APP_VERSION,
                    "latest_version": None,
                    "error": "GitHub rate limit reached; retry later",
                    "retry_after_seconds": int(_seconds_until_github_unblocked()),
                }

            if response.status_code == 404:
                # The configured branch or its VERSION file does not exist.
                _update_status = {
                    "status": "idle",
                    "progress": 100,
                    "message": f"VERSION not found on {GITHUB_BRANCH}",
                    "error": None,
                }
                return {
                    "update_available": False,
                    "current_version": APP_VERSION,
                    "latest_version": None,
                    "message": f"VERSION not found on {GITHUB_BRANCH}",
                }

            response.raise_for_status()
            version_data = response.json()
            encoded_version = version_data.get("content", "") if isinstance(version_data, dict) else ""
            try:
                # GitHub's Contents API may line-wrap Base64 payloads. Remove
                # transport whitespace before strict validation so a valid
                # VERSION file is not rejected.
                compact_version = "".join(encoded_version.split())
                latest_version = base64.b64decode(compact_version, validate=True).decode("utf-8").strip()
            except (ValueError, UnicodeDecodeError):
                latest_version = ""

            if not latest_version:
                _update_status = {
                    "status": "idle",
                    "progress": 100,
                    "message": f"Invalid VERSION on {GITHUB_BRANCH}",
                    "error": None,
                }
                return {
                    "update_available": False,
                    "current_version": APP_VERSION,
                    "latest_version": None,
                    "message": f"Invalid VERSION on {GITHUB_BRANCH}",
                }

            update_available = is_newer_version(latest_version, APP_VERSION)

            _update_status = {
                "status": "idle",
                "progress": 100,
                "message": "Update available" if update_available else "Up to date",
                "error": None,
            }

            is_docker = _is_docker_environment()
            is_ha_addon = _is_ha_addon()
            if is_ha_addon:
                update_method = "ha_addon"
            elif is_docker:
                update_method = "docker"
            else:
                update_method = "git"
            return {
                "update_available": update_available,
                "current_version": APP_VERSION,
                "latest_version": latest_version,
                "release_name": f"{GITHUB_BRANCH} branch",
                "release_notes": "",
                "release_url": f"https://github.com/{GITHUB_REPO}/tree/{GITHUB_BRANCH}",
                "published_at": "",
                "is_docker": is_docker,
                "is_ha_addon": is_ha_addon,
                "update_method": update_method,
            }

    except httpx.HTTPError as e:
        logger.error("Failed to check for updates: %s", e)
        _update_status = {
            "status": "error",
            "progress": 0,
            "message": "Failed to check for updates",
            "error": "Failed to check for updates",
        }
        return {
            "update_available": False,
            "current_version": APP_VERSION,
            "latest_version": None,
            "error": "Failed to check for updates",
        }


async def _perform_update(target_ref: str):
    """Perform the actual update using git fetch and reset.

    `target_ref` is the remote-tracking branch selected by the update workflow.
    """
    global _update_status

    try:
        # Every git step runs against the working tree (app_dir), NOT base_dir.
        # On a standard install with DATA_DIR=INSTALL_PATH/data, git happens
        # to walk up from a subdirectory of the repo to find .git so cwd=base_dir
        # used to silently work — but only by accident. On a native install with
        # DATA_DIR mounted at an unrelated path (e.g. /srv/bambuddy/data while
        # the install is /opt/bambuddy — see #1715), git can't walk up and every
        # operation fails with "not a git repository". safe.directory has the
        # same requirement: it must equal the repo root git discovers, not the
        # data dir, or every call returns "fatal: detected dubious ownership."
        app_dir = settings.app_dir

        # Find git executable (may not be in PATH when running as systemd service)
        git_path = _find_executable("git")
        if not git_path:
            _update_status = {
                "status": "error",
                "progress": 0,
                "message": "Git not found",
                "error": "Could not find git executable. Please ensure git is installed.",
            }
            return

        logger.info("Using git at: %s", git_path)

        # Git config to avoid safe.directory issues — must point at the working
        # tree (where .git lives), see app_dir comment above.
        git_config = ["-c", f"safe.directory={app_dir}"]

        _update_status = {
            "status": "downloading",
            "progress": 10,
            "message": "Configuring git...",
            "error": None,
        }

        # Ensure remote points at the expected repo. We previously rewrote
        # origin to HTTPS unconditionally on the assumption that systemd
        # service users wouldn't have SSH keys configured — which is fine
        # for that case, but stomps on developer checkouts where origin is
        # legitimately points at Grove Control over SSH and the user
        # auths via SSH keys. After the rewrite, `git push` prompts for
        # HTTPS credentials and fails.
        # New behaviour: read the current origin, parse out the
        # `<owner>/<repo>` pair, and only rewrite if it doesn't already
        # resolve to the right GitHub repo. SSH origins pointing at the
        # correct repo are preserved; only missing / wrong / corrupted
        # origins get reset to HTTPS.
        https_url = f"https://github.com/{GITHUB_REPO}.git"
        if not await _origin_points_at_repo(git_path, git_config, app_dir, GITHUB_REPO):
            process = await asyncio.create_subprocess_exec(
                git_path,
                *git_config,
                "remote",
                "set-url",
                "origin",
                https_url,
                cwd=str(app_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await process.communicate()

        _update_status = {
            "status": "downloading",
            "progress": 20,
            "message": "Fetching latest changes...",
            "error": None,
        }

        # Fetch the canonical Grove Control remote before resetting to its
        # configured branch.
        process = await asyncio.create_subprocess_exec(
            git_path,
            *git_config,
            "fetch",
            "--prune",
            "--force",
            "origin",
            cwd=str(app_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Git fetch failed"
            logger.error("Git fetch failed: %s", error_msg)
            _update_status = {
                "status": "error",
                "progress": 0,
                "message": "Failed to fetch updates",
                "error": error_msg,
            }
            return

        _update_status = {
            "status": "downloading",
            "progress": 40,
            "message": "Applying updates...",
            "error": None,
        }

        # Hard reset to the configured remote branch (clean update, no merge
        # conflicts). The local branch name does not change; only HEAD moves.
        process = await asyncio.create_subprocess_exec(
            git_path,
            *git_config,
            "reset",
            "--hard",
            target_ref,
            cwd=str(app_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            error_msg = stderr.decode() if stderr else "Git reset failed"
            logger.error("Git reset failed: %s", error_msg)
            _update_status = {
                "status": "error",
                "progress": 0,
                "message": "Failed to apply updates",
                "error": error_msg,
            }
            return

        _update_status = {
            "status": "installing",
            "progress": 50,
            "message": "Installing dependencies...",
            "error": None,
        }

        # Install Python dependencies — must run from the source-code directory
        # (where requirements.txt lives). app_dir is already resolved at the top
        # of this function; see the comment there for why every step uses it
        # instead of base_dir.
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "pip",
            "install",
            "-r",
            "requirements.txt",
            "-q",
            cwd=str(app_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            logger.warning("pip install warning: %s", stderr.decode() if stderr else "unknown")

        # Try to build frontend if npm is available (optional - static files are pre-built)
        npm_path = _find_executable("npm")
        frontend_dir = app_dir / "frontend"

        if npm_path and frontend_dir.exists():
            _update_status = {
                "status": "installing",
                "progress": 70,
                "message": "Building frontend...",
                "error": None,
            }

            # npm install
            process = await asyncio.create_subprocess_exec(
                npm_path,
                "install",
                cwd=str(frontend_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await process.communicate()

            # npm run build
            process = await asyncio.create_subprocess_exec(
                npm_path,
                "run",
                "build",
                cwd=str(frontend_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                logger.warning("Frontend build warning: %s", stderr.decode() if stderr else "unknown")
        else:
            logger.info("npm not found or frontend dir missing - using pre-built static files")

        _update_status = {
            "status": "complete",
            "progress": 100,
            "message": "Update complete! Please restart the application.",
            "error": None,
        }

        logger.info("Update completed successfully")

    except Exception as e:
        logger.error("Update failed: %s", e)
        _update_status = {
            "status": "error",
            "progress": 0,
            "message": "Update failed",
            "error": "Update failed unexpectedly",
        }


@router.post("/apply")
async def apply_update(
    background_tasks: BackgroundTasks,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Apply available update (git pull + rebuild)."""
    global _update_status

    if _update_status["status"] in ["downloading", "installing"]:
        return {
            "success": False,
            "message": "Update already in progress",
            "status": _update_status,
        }

    # Check for managed deployment shapes that own the update lifecycle.
    # HA addons are also Docker, so check HA first to surface the more
    # specific message.
    if _is_ha_addon():
        return {
            "success": False,
            "is_ha_addon": True,
            "is_docker": True,
            "message": (
                "Grove Control is running as a Home Assistant addon. "
                "Updates are managed by the Home Assistant Supervisor "
                "(Settings → Add-ons → Grove Control → Update)."
            ),
        }
    if _is_docker_environment():
        return {
            "success": False,
            "is_docker": True,
            "message": (
                "Docker installations cannot be updated in-app. "
                "Please update via Docker Compose: "
                "git pull && docker compose build --pull && docker compose up -d"
            ),
        }
    # Start update in background
    background_tasks.add_task(_perform_update, f"origin/{GITHUB_BRANCH}")

    _update_status = {
        "status": "downloading",
        "progress": 10,
        "message": "Starting update...",
        "error": None,
    }

    return {
        "success": True,
        "message": "Update started",
        "status": _update_status,
    }


@router.get("/status")
async def get_update_status(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SYSTEM_READ),
):
    """Get current update status."""
    return _update_status
