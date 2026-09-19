# Issue #168 test migration ledger

The PrintJob work changes the source of lifecycle truth, not the observable
queue behaviour. Every legacy assertion therefore has one of three outcomes:
translated to a lifecycle invariant, retained as a compatibility assertion, or
explicitly retired because it relied on unsafe identity inference.

| Existing coverage | Outcome | Replacement / retained assertion |
| --- | --- | --- |
| `test_chamber_heat_soak.py` | Translate | A job reserves its printer before heater commands; `heat_soaking` gets a new operation ID on each entry; stale heat-soak work cannot alter a later job. |
| `test_scheduler_watchdog.py` and dispatch-start tests | Translate | Only a pre-send dispatch can return to `queued`; after the command-attempt boundary uncertainty and reservation remain until attributed reconciliation. |
| `test_print_start_expected_promotion.py` and `test_subtask_archive_resume.py` | Translate | Device subtask ID is persisted as a PrintJob binding and promotes only its owned job. Process-local expected-print maps are no longer the authority. |
| `test_reconcile_stale_active_prints.py` | Translate | Startup/reconnect recovery preserves unresolved ownership, accepts a direct terminal result only with strict task/connection/sequence evidence, and quarantines ambiguity. |
| `test_print_queue_api.py` | Retain and extend | Existing queue fields and status strings remain compatible; responses add `job_id`, while terminal jobs are hidden with `queue_visible=false` rather than deleted. |
| `test_printers_api.py` and plate-clear tests | Translate | Existing `awaiting_plate_clear` remains available; its owning `job_id` fences late completion/clear work. |
| Print log service tests | Retain and extend | A terminal log remains a compatibility projection and has at most one deterministic `job_id`; jobs without a log still remain durable terminal records. |
| Migration tests | New | Legacy rows receive UUIDs/events; duplicate active rows create a safety hold without a recency election; only exact queue-item log links are backfilled. |
| Scheduler selection tests | Retain and extend | Scheduling properties remain separate from lifecycle state; active reservation or safety hold blocks a printer even when queue visibility changes. |
| Effects / notification / cleanup tests | New | Effects deduplicate on job, operation, source event and type, can be retried after a crash, and stale leased work is fenced before external action. |

The focused lifecycle tests exercise the transition graph, compare-and-set
failure, reservation exclusivity, operation fencing, effect de-duplication,
retry lineage, migration conflicts, direct-terminal proof requirements, and
reconnect/takeover quarantine. Existing broad queue, scheduler, heat-soak,
print-completion, API, and frontend tests remain required in the final matrix.
