"""A simulated Bambu printer behind the real MQTT client.

The app's ``BambuMQTTClient`` runs unchanged; only its paho connection is
replaced. Commands the app publishes reach ``FakePrinter.receive``, and the
printer answers with status reports through the client's own message
processing, so start, pause and completion detection are the production code.
"""

import asyncio
import io
import json
import zipfile
from dataclasses import dataclass, field
from functools import partial
from types import SimpleNamespace
from typing import Any


class FakePaho:
    """Stands in for paho's client: publishes go to the printer, nothing touches the network."""

    def __init__(self, printer: "FakePrinter"):
        self._printer = printer

    def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False):
        self._printer.receive(json.loads(payload))
        return SimpleNamespace(rc=0, mid=0, is_published=lambda: True, wait_for_publish=lambda *_a, **_k: None)

    def disconnect(self, *_args, **_kwargs):
        event = getattr(self._printer.client, "_disconnection_event", None)
        if event is not None:
            event.set()
        return 0

    def __getattr__(self, _name: str):
        return lambda *_args, **_kwargs: 0


@dataclass
class FakePrinter:
    """One printer: its reported state, the commands it received and its SD card."""

    printer_id: int
    serial: str
    clock: Any = None
    sd: dict[str, bytes] = field(default_factory=dict)
    commands: list[dict] = field(default_factory=list)
    # False: the printer ignores print commands (a lost command). "id_only": it
    # reports the print's ID but never starts it.
    accepts_prints: bool | str = True
    reconnects: int = 0  # MQTT sessions the app forced to reconnect.
    # When False the printer ignores Stop and keeps printing.
    accepts_stop: bool = True
    # When False uploads fail; while ``upload_gate`` is set and unopened, uploads wait on it.
    accepts_uploads: bool = True
    upload_gate: asyncio.Event | None = None
    uploading: int = 0  # Uploads in progress.
    # While set and unopened, downloads from the SD card wait on it.
    download_gate: asyncio.Event | None = None
    downloading: int = 0
    client: Any = None
    report: dict = field(
        default_factory=lambda: {
            "gcode_state": "IDLE",
            "gcode_file": "",
            "subtask_name": "",
            "subtask_id": "0",
            "mc_percent": 0,
            "mc_remaining_time": 0,
            "layer_num": 0,
            "total_layer_num": 0,
            "bed_temper": 25.0,
            "bed_target_temper": 0.0,
            "nozzle_temper": 25.0,
            "nozzle_target_temper": 0.0,
            "mc_target_cham": 0.0,
        }
    )

    # -- what the app sent -------------------------------------------------

    def receive(self, message: dict) -> None:
        body = message.get("print") or {}
        self.commands.append(body)
        command = body.get("command")
        loop = asyncio.get_running_loop()
        if command == "project_file" and self.accepts_prints == "id_only":
            loop.call_soon(partial(self.push, subtask_id=str(body.get("subtask_id") or "0")))
        elif command == "project_file" and self.accepts_prints:
            loop.call_soon(self._start, body)
        elif command == "stop" and self.accepts_stop:
            loop.call_soon(self.fail)
        elif command == "pause":
            loop.call_soon(self.pause)
        elif command == "resume":
            loop.call_soon(self.resume)
        elif command == "gcode_line":
            for line in str(body.get("param", "")).splitlines():
                code, _, value = line.partition(" S")
                if code.strip() == "M140":
                    loop.call_soon(partial(self.push, bed_target_temper=float(value)))
                elif code.strip() == "M141":
                    loop.call_soon(partial(self.push, mc_target_cham=float(value)))
        elif command == "set_airduct":
            loop.call_soon(partial(self.push, device={"airduct": {"modeCur": body.get("modeId", 0)}}))

    def sent(self, command: str) -> list[dict]:
        return [body for body in self.commands if body.get("command") == command]

    def _start(self, body: dict) -> None:
        url = body.get("url") or ""
        filename = url.rsplit("/", 1)[-1] if url else body.get("param", "")
        self.push(
            gcode_state="RUNNING",
            gcode_file=filename,
            subtask_name=body.get("subtask_name", ""),
            subtask_id=str(body.get("subtask_id") or "0"),
            mc_percent=1,
            mc_remaining_time=30,
            layer_num=1,
            total_layer_num=100,
        )

    # -- what the printer reports -------------------------------------------

    def push(self, **changes: Any) -> None:
        """Report the printer's full state with ``changes`` applied."""
        self.report.update(changes)
        self.client.state.connected = True
        self.client._process_message({"print": dict(self.report)})
        # Reports are stamped on the scenario's clock, not the wall clock.
        stamp = self.clock.now().timestamp()
        reports = self.client.state.heat_soak_reports
        for key, (value, _stamp) in list(reports.items()):
            reports[key] = (value, stamp)

    def start_local(self, filename: str = "local.3mf", subtask_id: str = "0", on_sd: bool = True) -> None:
        """A print started from the touchscreen or SD card, of a file on its SD card."""
        if on_sd:
            self.sd.setdefault(f"/{filename}", sliced_3mf())
        self.push(
            gcode_state="RUNNING",
            gcode_file=filename,
            subtask_name=filename.removesuffix(".3mf"),
            subtask_id=subtask_id,
            mc_percent=1,
        )

    @property
    def active(self) -> bool:
        return self.report["gcode_state"] in ("PREPARE", "RUNNING", "PAUSE")

    def finish(self) -> None:
        """The print completes; a printer that isn't printing just repeats its state."""
        if self.active:
            self.report.update(gcode_state="FINISH", mc_percent=100, mc_remaining_time=0)
        self.push()

    def fail(self) -> None:
        if self.active:
            self.report.update(gcode_state="FAILED")
        self.push()

    def pause(self) -> None:
        if self.report["gcode_state"] == "RUNNING":
            self.report.update(gcode_state="PAUSE")
        self.push()

    def resume(self) -> None:
        if self.report["gcode_state"] == "PAUSE":
            self.report.update(gcode_state="RUNNING")
        self.push()

    def idle(self) -> None:
        self.push(gcode_state="IDLE")

    def disconnect(self) -> None:
        """The printer drops off the network."""
        self.client.state.connected = False
        self.client.state.heat_soak_disconnected_at = self.clock.now().timestamp()
        if self.client.on_state_change:
            self.client.on_state_change(self.client.state)


def sliced_3mf() -> bytes:
    """A minimal sliced 3MF: one plate of G-code."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", ";HEADER_BLOCK_START\nG28\nM400\n; end\n")
    return buffer.getvalue()
