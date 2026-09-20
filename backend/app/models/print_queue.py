from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


def _new_uuid() -> str:
    return str(uuid4())


class PrintQueueItem(Base):
    """Print queue item for scheduled/queued prints."""

    __tablename__ = "print_queue"
    id: Mapped[int] = mapped_column(primary_key=True)

    # Durable public identity. The physical table remains ``print_queue`` for
    # compatibility, but all lifecycle ownership is keyed by this opaque UUID.
    job_id: Mapped[str] = mapped_column(String(36), default=_new_uuid, unique=True, index=True)
    previous_job_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    lifecycle_state: Mapped[str] = mapped_column(String(20), default="queued", server_default="queued", index=True)
    lifecycle_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    uncertainty_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    terminal_reason: Mapped[str | None] = mapped_column(String(100), nullable=True)
    queue_visible: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    active_operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    dispatch_attempted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    physical_execution_observed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Links
    # A printer is a replaceable execution target, not the owner of job
    # history.  Removing a printer must detach queued jobs and preserve their
    # durable lifecycle evidence.
    printer_id: Mapped[int | None] = mapped_column(ForeignKey("printers.id", ondelete="SET NULL"), nullable=True)
    # Target printer model for model-based assignment (mutually exclusive with printer_id)
    # When set, scheduler assigns to any idle printer of matching model
    target_model: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Target location filter for model-based assignment (only used with target_model)
    # When set, only printers in this location are considered
    target_location: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Required filament types for model-based assignment (JSON array, e.g., '["PLA", "PETG"]')
    # Used by scheduler to validate printer has compatible filaments loaded
    required_filament_types: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Waiting reason - explains why a model-based job hasn't started yet
    # Set by scheduler when no matching printer is available
    waiting_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Either archive_id OR library_file_id must be set (archive created at print start from library file)
    # Archives are reusable content; deleting one must not delete the jobs that
    # attempted to print it.
    archive_id: Mapped[int | None] = mapped_column(ForeignKey("print_archives.id", ondelete="SET NULL"), nullable=True)
    library_file_id: Mapped[int | None] = mapped_column(
        ForeignKey("library_files.id", ondelete="SET NULL"), nullable=True
    )
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    # Scheduling
    position: Mapped[int] = mapped_column(Integer, default=0)  # Queue order
    scheduled_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # None = ASAP
    manual_start: Mapped[bool] = mapped_column(Boolean, default=False)  # Requires manual trigger to start
    # Per-job drying policy. False means printing takes priority: stop every
    # active AMS drying cycle and wait for telemetry to confirm it stopped
    # before dispatch. True leaves drying alone and waits for natural completion.
    wait_for_drying_complete: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Explicit queue-only heat soak. Timer begins when heater commands are sent.
    chamber_heat_soak: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    heat_soak_temperature: Mapped[int] = mapped_column(Integer, default=60, server_default="60")
    heat_soak_minutes: Mapped[int] = mapped_column(Integer, default=30, server_default="30")
    preheat_owner: Mapped[str | None] = mapped_column(String(36), nullable=True)
    preheat_requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    preheat_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    preheat_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Conditions
    require_previous_success: Mapped[bool] = mapped_column(Boolean, default=False)

    # Power management
    auto_off_after: Mapped[bool] = mapped_column(Boolean, default=False)  # Power off printer after print

    # AMS mapping: JSON array of global tray IDs for each filament slot
    # Format: "[5, -1, 2, -1]" where position = slot_id-1, value = global tray ID (-1 = unused)
    ams_mapping: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Per-slot filament requirements and force-colour preferences: JSON array of override objects
    # Format: '[{"slot_id": 1, "type": "PLA", "color": "#FFFFFF"}]'
    # Only slots with overrides are included (sparse). null = use original 3MF values.
    filament_overrides: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Queue-level fail-closed preference. Every creation path defaults true;
    # false is only persisted for an explicit user opt-out.
    force_color_match: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    # Plate ID for multi-plate 3MF files (1-indexed, None = auto-detect/plate 1)
    plate_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Shortest-job-first scheduling
    print_time_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)  # Cached from archive/library
    been_jumped: Mapped[bool] = mapped_column(Boolean, default=False)  # Starvation guard for SJF

    # Auto-print G-code injection (#422)
    gcode_injection: Mapped[bool] = mapped_column(Boolean, default=False)

    # H2C dual-nozzle-rack slicer pick preservation (#1780). BambuStudio's
    # project_file MQTT command for rack-swap-capable models (O1C2 today)
    # carries per-filament physical nozzle position IDs in `nozzle_mapping`,
    # forwarded verbatim through the queue and replayed by the dispatcher so
    # the firmware honours the user's pick instead of falling back to
    # "last matching nozzle type" auto-pick. Stored as opaque JSON string
    # (list[int]); NULL on every other model. `nozzles_info` is a deprecated
    # column from the original #1780 attempt — kept nullable so old rows still
    # load; never written to or read from.
    nozzle_mapping: Mapped[str | None] = mapped_column(Text, nullable=True)
    nozzles_info: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Printer-card direct uploads create transient library rows. When this is
    # true, the scheduler deletes the source row/files after archiving a copy.
    cleanup_library_after_dispatch: Mapped[bool] = mapped_column(Boolean, default=False)

    # Print options. bed_levelling / flow_cali / nozzle_offset_cali are tri-state
    # strings (off/on/auto) matching BambuStudio; "auto" = skip if recently done.
    # The remaining three stay boolean (BambuStudio exposes no auto for them).
    bed_levelling: Mapped[str] = mapped_column(String(8), default="auto")
    flow_cali: Mapped[str] = mapped_column(String(8), default="auto")
    vibration_cali: Mapped[bool] = mapped_column(Boolean, default=True)
    layer_inspect: Mapped[bool] = mapped_column(Boolean, default=False)
    timelapse: Mapped[bool] = mapped_column(Boolean, default=False)
    use_ams: Mapped[bool] = mapped_column(Boolean, default=True)
    # Nozzle offset calibration — dual-nozzle printers only, MQTT-gated (#1682)
    nozzle_offset_cali: Mapped[str] = mapped_column(String(8), default="auto")

    # Status: pending, preheating, dispatching, printing, completed, failed, skipped, cancelled
    status: Mapped[str] = mapped_column(String(20), default="pending")

    # Durable dispatch claim. A queue worker stamps this before slow source
    # preparation or FTP I/O so pending rows cannot be reassigned or selected
    # by another worker. The claim is cleared when the worker exits; startup
    # reconciliation clears claims left by a process restart.
    dispatching_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Cleared by the per-printer "Resume after failure" action (#1818) so the
    # scheduler's `_check_previous_success` lookback skips this row. Without
    # this, a single `failed` or `aborted` print poisoned every later
    # `require_previous_success` item on the same printer forever — the
    # lookback excluded `skipped` but had no way to dismiss the originating
    # failure. The flag is per-item, not per-printer, so a fresh failure
    # after a resume re-gates downstream items independently.
    gate_acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)

    # Set by the dispatch scheduler when the assigned spool can't satisfy
    # this print's per-slot filament weight (#1496). Display-only flag — the
    # actual deficit is recomputed live every time the user clicks ▶, so
    # swapping a spool to a fuller one between flag and dispatch clears the
    # block automatically.
    filament_short: Mapped[bool] = mapped_column(Boolean, default=False)

    # User has acknowledged the filament-shortage warning for this item
    # ("Print Anyway"). Set by the start route when the user passes
    # skip_filament_check=true, or at queue-creation time if PrintModal's
    # frontend deficit warning was acknowledged. Survives scheduler ticks so
    # the dispatch no longer bounces between "user said anyway" and
    # "scheduler re-flagged" (#1698-followup).
    skip_filament_check: Mapped[bool] = mapped_column(Boolean, default=False)

    # Tracking
    # Set immediately before the MQTT project_file command is sent. A queue
    # item is only promoted from ``dispatching`` to ``printing`` once printer
    # telemetry reports an active print state.
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # The submission id embedded in the MQTT project_file command. It is
    # persisted before dispatch so terminal printer telemetry can still be
    # attributed to this exact attempt after an application restart.
    dispatch_subtask_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # User tracking (who added this to the queue)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Relationships
    printer: Mapped["Printer"] = relationship()
    archive: Mapped["PrintArchive | None"] = relationship()
    library_file: Mapped["LibraryFile | None"] = relationship()
    project: Mapped["Project | None"] = relationship(back_populates="queue_items")
    created_by: Mapped["User | None"] = relationship()
    variants: Mapped[list["PrintQueueVariant"]] = relationship(
        back_populates="queue_item",
        cascade="all, delete-orphan",
        order_by="PrintQueueVariant.position",
    )


# Domain name for the durable row.  The physical table and compatibility ORM
# class remain ``print_queue``/``PrintQueueItem`` for this migration, but new
# lifecycle code should speak in terms of PrintJob rather than inventing a
# second identity model.
PrintJob = PrintQueueItem


class PrintQueueVariant(Base):
    """One candidate file for a queue item that may print on several models (#671).

    A user with an H2S and an H2C slices the same job twice and does not care
    which machine runs it. Each slice becomes a variant; the scheduler walks them
    in ``position`` order and takes the first whose model has an idle printer.

    **This is a snapshot, not a pointer.** The candidate list is copied from the
    library's variant group when the item is queued, and every per-file setting
    the dispatcher needs is copied with it. Two reasons:

    - Editing the library group afterwards must not silently change a job that is
      already waiting in the queue.
    - The per-file settings genuinely differ between candidates and are choices
      the user made for *this* job, not properties of the file. An H2C slice is
      dual-nozzle and will not have the same slot count, AMS mapping or nozzle
      mapping as the H2S slice of the same model.

    On a match the winning variant's fields are written onto the queue row before
    the dispatch commit, so everything downstream — upload, archive creation,
    print history, reprint — sees an ordinary single-file item and needs no
    knowledge that variants exist.

    Variants reference library files only. An archive records a print that already
    happened, of one specific file, so it is never a candidate for "which of these
    should we run".
    """

    __tablename__ = "print_queue_variants"

    id: Mapped[int] = mapped_column(primary_key=True)
    queue_item_id: Mapped[int] = mapped_column(
        ForeignKey("print_queue.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # User's priority order. When two printers are idle in the same scheduler
    # pass, the lowest position wins — so the choice is reproducible instead of
    # depending on which match the matcher happened to find first.
    position: Mapped[int] = mapped_column(Integer, default=0)

    # CASCADE: deleting the file drops this candidate but leaves the item and its
    # other candidates alone. Losing the *last* candidate is handled by the
    # resolver, which holds the item pending with an explicit waiting_reason
    # rather than letting it sit there looking dispatchable forever.
    library_file_id: Mapped[int] = mapped_column(ForeignKey("library_files.id", ondelete="CASCADE"), nullable=False)
    # Normalized short name ("H2S"), taken from the file's own sliced_for_model
    # at creation, or picked by the user for a legacy file that declares none.
    target_model: Mapped[str] = mapped_column(String(50), nullable=False)

    # Per-file dispatch settings, same semantics as the identically named columns
    # on PrintQueueItem — see there for the formats.
    plate_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ams_mapping: Mapped[str | None] = mapped_column(Text, nullable=True)
    nozzle_mapping: Mapped[str | None] = mapped_column(Text, nullable=True)
    filament_overrides: Mapped[str | None] = mapped_column(Text, nullable=True)
    required_filament_types: Mapped[str | None] = mapped_column(Text, nullable=True)
    print_time_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # How many times this candidate has been dispatched and bounced back to
    # pending by the start-watchdog. The resolver tries least-attempted first, so
    # a printer that accepts the file and never starts (#1678) hands the job to
    # the other machine on the next lap instead of burning the item's whole
    # DISPATCH_MAX_ATTEMPTS budget against the same wedged printer — which is the
    # entire reason the user queued an alternative.
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    queue_item: Mapped["PrintQueueItem"] = relationship(back_populates="variants")
    library_file: Mapped["LibraryFile"] = relationship()


class PrintJobEvent(Base):
    """Immutable evidence for a committed PrintJob lifecycle transition."""

    __tablename__ = "print_job_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    job_id: Mapped[str] = mapped_column(String(36), index=True)
    queue_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("print_queue.id", ondelete="SET NULL"), nullable=True, index=True
    )
    operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    lifecycle_version: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(64))
    from_state: Mapped[str | None] = mapped_column(String(20), nullable=True)
    to_state: Mapped[str | None] = mapped_column(String(20), nullable=True)
    source: Mapped[str] = mapped_column(String(64))
    evidence_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PrintJobEffect(Base):
    """Durable consequence of a PrintJob event.

    Effects are claimed separately from the state transition. Their operation
    identity fences late workers from acting on a reused queue row.
    """

    __tablename__ = "print_job_effects"
    __table_args__ = (
        UniqueConstraint("job_id", "operation_id", "source_event_id", "effect_type", name="uq_print_job_effect"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    job_id: Mapped[str] = mapped_column(String(36), index=True)
    # Empty string is the durable key for effects that are job-scoped rather
    # than tied to a currently active operation. It must not be NULL: SQL
    # unique constraints treat NULL values as distinct and would otherwise
    # allow duplicate effects on PostgreSQL and SQLite.
    operation_id: Mapped[str] = mapped_column(String(36), nullable=False, default="", server_default="", index=True)
    source_event_id: Mapped[str] = mapped_column(String(36), index=True)
    effect_type: Mapped[str] = mapped_column(String(80))
    delivery_policy: Mapped[str] = mapped_column(String(32), default="idempotent_retry")
    state: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    lease_owner: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    dead_lettered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class PrintJobReservation(Base):
    """The single active execution reservation for a printer."""

    __tablename__ = "print_job_reservations"

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(36), index=True)
    operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lifecycle_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class PrintJobBinding(Base):
    """A retained immutable generation of printer task identity evidence."""

    __tablename__ = "print_job_bindings"
    __table_args__ = (
        UniqueConstraint("printer_id", "device_subtask_id", "generation", name="uq_print_job_binding_generation"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    job_id: Mapped[str] = mapped_column(String(36), index=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    device_subtask_id: Mapped[str] = mapped_column(String(64), index=True)
    generation: Mapped[int] = mapped_column(Integer, default=1)
    first_connection_epoch: Mapped[str | None] = mapped_column(String(36), nullable=True)
    last_connection_epoch: Mapped[str | None] = mapped_column(String(36), nullable=True)
    first_event_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_event_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PrintJobQuarantinedEvent(Base):
    """Device event retained when Grove cannot prove its owning PrintJob.

    This deliberately has no ``job_id``: attaching an ambiguous event to a
    plausible job would make the evidence look stronger than it is.
    """

    __tablename__ = "print_job_quarantined_events"
    __table_args__ = (
        UniqueConstraint("printer_id", "event_type", "correlation_key", name="uq_print_job_quarantined_event"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    correlation_key: Mapped[str] = mapped_column(String(128))
    reason: Mapped[str] = mapped_column(Text)
    evidence_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PrinterSafetyHold(Base):
    """A durable scheduling block, normally owned by a job operation.

    Legacy migration may create an unattributed hold when the original queue
    row no longer exists. New holds must always carry job and operation IDs.
    """

    __tablename__ = "printer_safety_holds"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    hold_type: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(20), default="active", index=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


from backend.app.models.archive import PrintArchive  # noqa: E402
from backend.app.models.library import LibraryFile  # noqa: E402
from backend.app.models.printer import Printer  # noqa: E402
from backend.app.models.project import Project  # noqa: E402
from backend.app.models.user import User  # noqa: E402
