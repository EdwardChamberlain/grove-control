# Files, Queue, and print Archives

Grove Control keeps these parts of a print workflow separate so a queued job
can be retried without exposing temporary uploads as user-managed files.

## Files

Files are the library of sliced files managed by the operator. They appear in
the Files page, can be organized into folders, and can be selected for later
prints. Automatic Files purging excludes temporary Queue-only uploads.

## Queue uploads

An upload made directly into the Queue is stored as a hidden Queue-only source.
It is available to queue items during setup and remains available while a
queued, active, or awaiting-plate-clear job references it, including through a
file variant. Once intake is
closed and no queue item needs the source, Grove Control removes it. A startup
sweep closes abandoned uploads after 24 hours; items already using the source
keep it safe.

## Print Archives

Entry into Dispatching creates an Archive attempt linked to the exact queue
item, in the same transaction as its printer hold and before upload. The
archived artifact is the exact local file uploaded to the printer, including
any G-code injection applied for that dispatch. Upload failures therefore
appear in Archive too. The attempt records its outcome when its job enters
Finished, Failed, or Cancelled; Clear Plate preserves that physical outcome.
Waiting cancellations and preheating failures or stops create no Archive. A reprint creates a new
dispatch attempt when submitted through the Queue.

When G-code injection is enabled, Grove Control surrounds its injected start
and end snippets with `GROVE_INJECT_*` marker comments. Every dispatch removes
those marked blocks from Archive and Files copies, including when injection is
off. If injection is on, Grove Control then applies the snippets currently
configured for that queue item, once. The saved source artifact is left
unchanged.

Use **Save to Files** on an Archive or a virtual-printer upload when the file
should become a persistent, operator-managed library file.

For Cancel, Stop, Clear Plate, Retry, and the one-time upgrade, see the
[Queue job lifecycle](queue-status-transitions.md).
