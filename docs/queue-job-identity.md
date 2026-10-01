# Queue job identity (issue #194, stage 2)

Stage 2 introduced durable identity matching. Stage 3 builds on it with the
[new job lifecycle and live Queue](queue-status-transitions.md). The identity
rules and device qualification checklist below still apply.

## Matching and external prints

Grove persists its numeric `submission_id` in `dispatch_subtask_id` before
sending `project_file`. MQTT start and finish callbacks carry an identity
snapshot. Queue and Archive attribution use that identity plus the printer;
filenames, display names, the last command and the most recent job are never
fallbacks for a missing ID. A delayed event cannot complete another job.

A touchscreen, SD-card or slicer print observed in PREPARE, SLICING, RUNNING or PAUSE creates an
ownerless `printing` Queue job. Duplicate observations reuse the same job. It
uses the existing archiving setting, completion, Stop and plate-clear paths.
An external job without an Archive file is labelled **External print**. Users
with permission to update all queue items can stop these ownerless jobs.

Some firmware reports `subtask_id=0` for local prints. The MQTT client assigns
a random ID to the observed run and carries it through partial updates and
completion. It cannot establish continuity across reconnect or application
restart without a firmware ID. An existing active reservation is preserved
instead of adopting a different print or matching by name. Inspect the printer
and use **Stop Print** to resolve such a reservation. No second active job is
created while another job reserves that printer.

An explicit zero, empty or null ID reported while a known-ID print is active also
starts a fresh observation: Grove cannot prove that an intervening finish/start
was not missed. The old reservation remains held instead of attributing the
unidentified run's completion to it. An omitted ID in a partial update, or a
zero ID only in the terminal update of a continuous observed run, retains that
run's identity.

**Stop Print** saves the existing plate-clear gate together with cancellation,
even if the printer is offline or its completion cannot identify the old job.
Inspect and clear the physical plate, then use **Clear Plate** before the next
queued job can dispatch.

If the firmware ID arrives after a partial start update, its callback carries
the exact prior session ID. The same job and linked Archive are bound to the
reported ID without repeating start effects. Archiving waits for file metadata
when the first active update has none.

Start and completion callbacks are serialized per printer so a short external
print cannot finish before its Archive link is stored. Other printers proceed
independently. External jobs reference their Archive using the existing column;
Files storage is unchanged.

## Startup and reconnect

The scheduler checks both `dispatching` and `printing` rows against connected
telemetry. Cached state from before a reconnect is not evidence. A matching
active ID confirms dispatch; a matching FINISH or FAILED records the physical
outcome and runs normal completion handling. The recovered terminal job retains the printer reservation until Clear Plate
(or automatic Clear Plate for successful completion with confirmation off).
Missing IDs, mismatches, disconnected printers and ambiguous IDLE reports leave
the job in its current state.

An interrupted heat soak stays reserved until the user chooses Stop or Skip
heat soak. A second live scheduler does not take over another worker's timer.
No heaters are restarted automatically after an application restart.

## Unconfirmed dispatch

After the existing 270-second acknowledgement window (or immediately for a
legacy dispatch without a timestamp), the Queue shows two actions:

- **It's printing**: confirm the job as `printing` after inspecting the printer.
- **It didn't start**: record `failed` and require the existing Clear Plate action.

`POST /api/v1/queue/{id}/resolve-dispatch` accepts
`{"outcome":"printing"}` or `{"outcome":"failed"}`. Queue update ownership
permissions apply. Concurrent changes, decisive conflicting telemetry and a
printer running another known job return 409. The endpoint uses the same
conditional transition writer as every other queue action. Display reasons
never determine which transition is permitted.

## Upgrade and validation

No schema change or data migration is needed: this stage reuses the dispatch
ID and Archive-link columns. A previously archived external print with a matching firmware ID can be
adopted into a job when its completion is observed. Old jobs without an ID
are not guessed into a new status. Resolve them using the Queue controls after inspecting the printer.
Existing webhook/MQTT status names remain unchanged.

Hardware validation is still required before claiming device qualification:

1. Queue a print; verify the submitted ID is echoed during setup, pause, resume
   and completion, including firmware that emits a zero terminal ID.
2. Start touchscreen and SD-card prints, including repeated filenames and
   `subtask_id=0`; verify one job, the Archive association and plate clearing.
3. Restart Grove during dispatch, RUNNING, PAUSE and heat soak; reconnect MQTT
   during a print and after a print finishes while disconnected.
4. Exercise both resolution actions, Stop, stale telemetry and two printers
   working at once. Verify no unrelated job or Archive changes.

The implementation is tested on SQLite. PostgreSQL and physical printers have
not been validated for this stage.
