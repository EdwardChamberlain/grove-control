"""Every launcher must be able to shut Bambuddy down gracefully.

Two defects, found together, both invisible until you look for them:

1. **The Docker image never received SIGTERM at all.** ``CMD ["sh", "-c",
   "uvicorn ..."]`` leaves the shell as PID 1 with uvicorn as its child, and
   dash does not forward signals. Measured on the shipped image: ``docker stop``
   ran the full 10s grace period, exited 137 (SIGKILL), and the container log
   contained no "Shutting down" line. So *every* stop, restart and image update
   was a hard kill — no WAL checkpoint, no MQTT disconnect, no virtual-printer
   teardown. ``exec`` makes uvicorn PID 1 and the signal lands.

2. **Uvicorn waits forever for in-flight requests.**
   ``timeout_graceful_shutdown`` defaults to None, and an MJPEG camera stream is
   a response that never completes — ``httptools``'s connection ``shutdown()``
   only flips ``keep_alive = False`` on an in-flight cycle, it does not close the
   transport. One open camera tile pins the process indefinitely, and the app's
   own teardown never runs because uvicorn only fires the lifespan shutdown
   *after* connections drain. The flag caps the wait and cancels the tasks; the
   camera generators already unwind cleanly on CancelledError.

Neither shows up in any functional test — the app is perfectly healthy right up
until you ask it to stop. Hence this: pin the launchers themselves.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[3]

FLAG = "--timeout-graceful-shutdown"


def _read(rel: str) -> str:
    path = REPO / rel
    assert path.is_file(), f"launcher moved or was removed: {rel}"
    return path.read_text()


def _uvicorn_lines(text: str) -> list[str]:
    """Lines that actually launch uvicorn, ignoring comments about it."""
    return [
        line for line in text.splitlines() if "uvicorn" in line and not line.lstrip().startswith(("#", "REM", "<!--"))
    ]


class TestDockerImage:
    def test_cmd_execs_uvicorn_so_it_becomes_pid_1(self):
        """Without exec, `sh` is PID 1, dash eats the SIGTERM, and docker stop
        always ends in SIGKILL after the grace period.
        """
        cmd = next(line for line in _read("Dockerfile").splitlines() if line.startswith("CMD "))

        assert "exec uvicorn" in cmd, (
            "Dockerfile CMD must `exec` uvicorn. Without it the shell stays as PID 1, "
            "uvicorn never receives SIGTERM, and every docker stop is a SIGKILL:\n" + cmd
        )

    def test_cmd_bounds_the_graceful_shutdown(self):
        cmd = next(line for line in _read("Dockerfile").splitlines() if line.startswith("CMD "))
        assert FLAG in cmd, cmd

    def test_compose_allows_more_than_dockers_default_grace(self):
        compose = _read("docker-compose.yml")
        assert "stop_grace_period:" in compose, (
            "docker-compose.yml should raise stop_grace_period above Docker's 10s default, "
            "so a slow teardown on a Pi is not clipped by a SIGKILL."
        )
