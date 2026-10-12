# Queue dispatch concurrency

Grove can upload queued jobs to independent printers in parallel. Configure
`queue_max_concurrent_uploads` in Settings → Concurrent printer uploads (or via
the settings API) to choose the maximum number of active upload/session
workers. The valid range is 1–16 and the default is 1, which preserves the
legacy serialized behavior.

The limit is a refillable pool: when one worker finishes or fails, the next
eligible queued item can use that slot. A printer reservation is separate from
the pool slot, so two jobs targeting the same printer remain serialized even
when the pool limit is higher. Pending jobs explain whether they are waiting
for an upload slot or a printer reservation. Queue state and dispatch
recovery remain durable; cancellation, disconnect, restart, and worker
failure release the in-memory reservation and leave the item for the normal
retry/recovery path.
Pool capacity is applied before model-targeted assignments are persisted, so
an Any Machine job waiting for a pool slot remains eligible for a fresh printer
match on the next scheduler pass.

Before source preparation or FTP I/O, each worker claims its queue row in the
database together with the printer selected for that pass. A reassignment that
wins before the claim is rejected and retried on a later pass; claimed rows
cannot be reassigned or selected by another worker. Cancellation and deletion
cancel the matching worker, and a final compare-and-set prevents a cancelled
or removed row from publishing an MQTT print command.

## Rollout

1. Leave the setting at `1` after deployment and confirm normal queue dispatch
   and recovery behavior.
2. Increase it gradually (for example, `2`, then `4`) while watching printer
   connectivity, host bandwidth, and queue error logs.
3. Raise it only when the Grove host and printer network can sustain the added
   concurrent FTP sessions. The FTP layer uses a dedicated executor so queue
   uploads do not consume the application's shared default executor.

## Rollback

Set `queue_max_concurrent_uploads` back to `1`. Existing workers are allowed
to finish, while subsequent scheduler passes dispatch one upload/session at a
time. If an in-flight worker is cancelled by shutdown or loses its connection,
the existing durable stale-dispatch recovery handles the queue item; no
database migration is required for this setting.
