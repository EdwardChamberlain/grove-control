# Changelog

## Unreleased

- Maintenance: the Status tab now has a machine rail on the left with **All
  machines** at the top (#368). All machines is one to-do list across every
  printer, ordered by how close each task is to being due and split into
  Overdue, Due soon and On track bands, with a countdown, usage meter and Mark as
  Done button on each row. Needs attention hides the on-track tasks, and a long
  on-track list collapses to eight rows. Picking a printer shows its lifetime
  print time, jobs and filament changes (print time stays editable) and its tasks
  grouped by status, with each task's last-done date and enable switch, plus a
  Log a repair button that opens the log form for that printer. The Log tab is
  now a list grouped by month, with the entry and a one-line note, printer,
  scheduled or unscheduled badge, hours, jobs or changes at the time, and who
  recorded it; the entry type filter is a segmented control.
- Queue: a finished or failed job now stays in the Queue tab as a yellow
  **Clear plate** line, with the hand icon, until its printer's plate is marked
  cleared (#366). The line has a Mark plate as cleared button, names the next
  job for that printer, and is hidden when plate-clear confirmation is off.
- Queue and Kiosk: colour now means a person needs to act, with green for
  printing (#364). Green is printing and heat soak, orange is paused, yellow is
  a plate waiting to be cleared and purple is waiting on something (material not
  available, a staged job waiting for a manual start, or short of filament).
  Everything else is the neutral card colour, including scheduled and
  dispatching jobs, which need nothing from you. Printer names, print option
  icons and the kiosk Queued and idle printer cells are neutral too, and a
  paused job's progress bar is orange. A staged job's gutter now says Staged.
- Queue and Kiosk: printing and queued jobs are now split into two groups with
  headings and counts, **Printing** and **Up next**, so what is running is easy
  to tell apart from what is waiting (#362). Printing includes paused and
  heat-soaking jobs, and on the kiosk the printers waiting for their plate to be
  cleared. Up next lists pending, scheduled, waiting and staged jobs in queue
  order. A heading is hidden when its group is empty. The Printing and Queued
  counts above the Queue page list now match the headings, so a job being
  dispatched counts as printing.
- Kiosk: the kiosk now matches the Print Queue page (#359). The Printers strip
  and the separate Active jobs section are gone, replaced by one read-only list
  that uses the same job lines as the Queue page, so printing, paused,
  heat-soaking, waiting, scheduled and pending jobs share its status colours and
  footers (progress, ETA, layers, pause reason, waiting reason). Jobs are ordered
  plate clear, paused, printing, then queue order. A row of counts under the logo
  summarises the fleet, a printer waiting for its plate to be cleared gets a
  pulsing line at the top of the list, and idle printers are named in a footer.
- Printers: paused prints are now orange across the Printers page, camera wall, kiosk and bulk toolbar. A paused printer shows a pause icon beside its name, its progress bar turns orange, its card and camera tile get an orange border and glow, and its row gets an orange background in the list view (#335).
- Queue: paused prints are now orange instead of sharing the yellow used for scheduled jobs, and the job card footer shows why the print paused (filament ran out, paused by user, front cover removed, nozzle or bed temperature fault) when the printer reports it (#335).
- Stats: each print now records the filament it actually used. A job sliced for
  black PLA but overridden to blue PLA shows as blue, and a spool tracked in
  inventory takes precedence over both the slice and the override. Only the
  plate that was printed counts, so multi-plate files no longer list every
  plate's filaments, and stopped prints keep their override. Prints without a
  queue override or tracked spool are unchanged (#340).
- Queue: removed the Shortest Job First (SJF) toggle (#339). The queue now has
  one scheduling policy and always follows the saved queue order, so you can
  reason about what prints next from the order you see. Installs that had SJF
  enabled switch to this automatically on upgrade; queued jobs keep their
  positions and print-time estimates. Reordering and Timeline estimates are
  unchanged. The `queue_shortest_first` setting and the `been_jumped` queue
  field are no longer part of the API.
- History: the User filter is now hidden for people who can only see their own
  prints, since there is no one else to filter by. It also no longer requests the
  user list for them, and a user filter saved earlier is dropped instead of
  silently hiding prints (#328).
- Archive: the recorded print name is now read-only (#329). The Edit Archive
  dialog shows it as text instead of an input, and the archive update API
  (`PATCH /api/v1/archives/{id}`) ignores a `print_name` it is sent, so an entry
  stays easy to match to the print that produced it. Existing names are kept as
  stored. Notes, tags, project, status and the other fields stay editable. To
  give a print a more useful name, use Save to Files and rename that copy.
- UI: dropdowns in forms now match the height of the text fields beside them.
  They were forced to the compact toolbar height (32px) and sat visibly shorter
  than neighbouring inputs. Dropdowns that don't set their own padding, such as
  those in toolbars, keep the compact size.
- Maintenance: tasks can now be due after a number of filament changes (#337).
  Pick "Filament Changes" as the interval type when adding or editing a task, or
  override a single printer's interval. A filament change is a filament load
  defined in the sliced file: the first load of each job plus every change
  after it, including colour changes painted within a layer. Cutter use and
  manual spool swaps are not tracked, so choose an interval that suits your
  printer. Each card shows the changes left (or overdue), and completing a task
  records the printer's change count in its history and the maintenance log. A
  print that stops early counts only the loads it reached. Changes are read
  from the archived print's 3MF, so a job whose file can't be read isn't
  counted. Existing printers start from their archived prints (an estimate: a
  completed run counts every load, any other run counts its initial load only).
- Maintenance: tasks can now be due after a number of finished print jobs, not
  just print hours or calendar days (#337). Pick "Print Jobs" as the interval
  type when adding or editing a task, or override a single printer's interval.
  Each card shows the jobs left (or overdue), and completing a task records the
  printer's job count in its history and the maintenance log. Every finished
  print counts, whatever its outcome, including jobs with no archive. Existing
  printers start from the number of runs already in their print log (a lower
  bound, since jobs that were never archived weren't recorded). A task switched
  to "Print Jobs" counts from the printer's lifetime total until it is next
  marked as done.
- Queue: tidied the page chrome around the job cards (#347). The Printing and
  Queued section headings are gone, so printing and queued jobs form one list.
  Filters, the List / By Printer toggle, sort, SJF and Select All now share a
  single toolbar line, and the layout toggle uses the same segmented control as
  the Inventory page. The empty state sits on the page background instead of in
  a dashed card.
- Queue: redesigned the job card. A full-height status gutter (Waiting,
  Printing, Pending, Scheduled and so on) replaces the status pill and doubles
  as the drag handle for pending jobs, where the icon swaps for a grip on hover.
  The selection checkbox now appears on the thumbnail on hover (and stays on every
  card once something is ticked). Edit is no longer a button: click the job name
  or the card. Cancel is the only action button. Staged jobs show Start in the
  footer strip beside the waiting reason, and option badges are now icons with
  tooltips. On mobile, tapping a card opens the editor and the checkbox is always shown.
- Archive is now a record of prints only. Remove `POST /archives/upload` and
  `POST /archives/upload-bulk`, which created Archive entries for files that
  were never printed, along with the unused `UploadModal` and its API client
  methods, and the `archives:create` permission, which guarded nothing else.
  Add files to Files with `POST /library/files`, or print them via the Queue.
  Existing `archives:create` grants on custom roles are removed on startup (#232).
- Add a Grove-managed Temporary Files folder (#237). Direct uploads from a
  printer card and Queue → Add Job land there instead of the root of Files,
  and are removed once sent to a printer or after 7 days unused
  (configurable). Move a file out to keep it. On first start, root-level Files
  whose only queue history is cancelled or failed direct-upload jobs are
  moved in. API: `POST /library/files` gains `temporary=true`, and
  `cleanup_library_after_dispatch` is no longer accepted on `POST /queue/`.
- Files: each file's menu now offers Move.
- Remove the retired `POST /archives/{id}/reprint` endpoint, which only returned
  `410 Gone`. Reprint an archive by creating a queue item with `POST /queue/`;
  nothing in the frontend called the old route (#193).
- Restore the print workflow from `ee00437`, retaining queue-item retargeting
  (#186), direct Queue upload (#188), frontend dependency security fixes
  (#210), live Print/Queue labels (#213), and count-based Archive retention
  (#199). The Files/Archive split (#189) and subsequent lifecycle changes are
  excluded from this candidate.
- Keep the existing Queue history, pending/skipped states, configured print
  Auto Off cooldowns, and interrupted heat-soak shutdown recovery.
- Archive retention protects waiting/active reprint sources and the persisted
  plate-clear Archive. Count-policy changes require an explicit Apply after
  preview; age-based retention remains the default.
- Data migrated by the withdrawn development lifecycle is not downgraded.
  Use a fresh test database or a compatible backup; see UPDATING.md.

## 1.0.0

Grove Control 1.0.0 is the stable release line.

### Upgrade notes

- Stable Docker images are published as `latest` and `1.0.0`; the stable tag
  has no `v` prefix.
- Development images use the separate `dev` tag and should not be used for
  production data.
- Existing Grove Control SQLite and PostgreSQL databases run the current
  schema migrations automatically on application startup.
- Create and download a backup before upgrading, and keep it until the new
  installation has been verified. Backups include the database and application
  data; explicitly configured environment secrets must be saved separately.

### Compatibility

- `TZ` defaults to `UTC` in Compose and in the application. Set an IANA timezone
  in the Docker Compose `.env`; source/native installs must export `TZ` in the
  process or service environment for local scheduled times such as scheduled
  backups.
- `DEBUG=false` is the safe default. Set it to `true` only for temporary
  diagnostics because it also enables SQLAlchemy engine logging; use
  `LOG_LEVEL=DEBUG` for application debug logs without SQL query echoing.
- BambuBuddy-to-Grove Control database conversion and queue-table rebuilding
  remain explicit, SQLite-only recovery operations. They are not part of a
  routine 1.0.0 upgrade and can discard transient queued/runtime state.
