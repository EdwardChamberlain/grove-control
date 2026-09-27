# Files, Queue, and print Archives

Grove Control keeps these parts of a print workflow separate so a queued job
can be retried without exposing temporary uploads as user-managed files.

## Files

Files are the library of sliced files managed by the operator. They appear in
the Files page, can be organized into folders, and can be selected for later
prints. Automatic Files purging excludes temporary Queue-only uploads.

## Queue uploads

An upload made directly into the Queue is stored as a hidden Queue-only source.
It is available to queue items during setup and remains available while an
active, skipped, or retryable failed item still needs its bytes. Once intake is
closed and no queue item needs the source, Grove Control removes it. A startup
sweep closes abandoned uploads after 24 hours; items already using the source
keep it safe.

## Print Archives

Dispatch creates an Archive attempt linked to the exact queue item. The
archived artifact is the exact local file sent to the printer, including any
G-code injection applied for that dispatch. The attempt then records whether
the print started, completed, failed, or was stopped. A reprint creates a new
dispatch attempt when submitted through the Queue.

When G-code injection is enabled, Grove Control surrounds its injected start
and end snippets with `GROVE_INJECT_*` marker comments. Reprinting a snapshot
removes only those marked blocks and applies the snippets currently configured
for that queue item, once. The saved Archive artifact is left unchanged.

Use **Save to Files** on an Archive or a virtual-printer upload when the file
should become a persistent, operator-managed library file.
