# SQLite archive and queue integrity

Grove does not enable SQLite foreign-key enforcement globally. Some unrelated
relationships have application-specific cleanup or preservation behavior, so
changing the connection-wide pragma would alter more than archive deletion.

`run_migrations()` installs targeted SQLite triggers for
`print_queue.archive_id`. They reject new or updated queue references to a
missing archive, remove linked queue rows in the same transaction as a hard
archive delete, and prevent deletion while a queue item is preheating,
dispatching, or printing. PostgreSQL continues to use the declared
`ON DELETE CASCADE` foreign key, with the same active-job guard in the API.

On startup, Grove reports existing queue rows whose archive has already been
deleted. It leaves those rows intact for operator review because an orphan may
be active and should not be silently removed. The warning includes sample row
IDs, archive IDs, and statuses.
