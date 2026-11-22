"""Why a pending queue item is waiting, and whether a person has to act on it.

The dispatch scheduler writes a free-text ``waiting_reason`` on an item it could
not start. Some of those reasons clear by themselves (the assigned printer is
busy, the upload pool is full, AMS drying is running) and some need a person
(a missing material, a manual filament fix, an incompatible file). The queue UI
colours a job only when someone has to act, so the API reports that as
``waiting_needs_action`` instead of leaving the frontend to guess from English
text.

The strings the scheduler writes for the self-resolving cases live here, so the
scheduler and the classifier cannot drift apart.
"""

# Assigned printer is busy; the job starts when it frees up. The printer name
# follows: "Waiting for printer reservation on <name>".
PRINTER_RESERVATION_PREFIX = "Waiting for printer reservation"
# The upload pool is full: "Waiting for upload slot (<n> of <limit> in use)".
UPLOAD_POOL_WAITING_PREFIX = "Waiting for upload slot"
# AMS drying is running or being stopped before dispatch.
WAITING_FOR_DRYING_MESSAGE = "Waiting for AMS drying to complete"
STOPPING_DRYING_MESSAGE = "Stopping AMS drying before dispatch"
DRYING_STOP_FAILED_MESSAGE = "Unable to stop AMS drying; waiting to retry"
# A cross-model item whose candidate printers are all printing: "Busy: <names>".
BUSY_PREFIX = "Busy:"

# DRYING_STOP_FAILED_MESSAGE contains the "; " that separates the clauses of a
# cross-model reason, so it is swapped for a token before the reason is split.
_DRYING_STOP_FAILED_TOKEN = "Unable to stop AMS drying, waiting to retry"

_AUTOMATIC_PREFIXES: tuple[str, ...] = (
    PRINTER_RESERVATION_PREFIX,
    UPLOAD_POOL_WAITING_PREFIX,
    WAITING_FOR_DRYING_MESSAGE,
    STOPPING_DRYING_MESSAGE,
    _DRYING_STOP_FAILED_TOKEN,
    BUSY_PREFIX,
)


def _is_automatic_clause(clause: str) -> bool:
    """True for one clause of a reason that resolves without anyone acting."""
    clause = clause.strip()
    # A cross-model item with mixed reasons labels each clause "<model>: <reason>".
    candidates = [clause]
    if ": " in clause:
        candidates.append(clause.split(": ", 1)[1].strip())
    return any(candidate.startswith(_AUTOMATIC_PREFIXES) for candidate in candidates)


def waiting_reason_needs_action(waiting_reason: str | None) -> bool:
    """Whether a person has to do something for this waiting item to start.

    ``False`` with no reason, and when every clause is a self-resolving wait.
    Anything else, including a reason this module does not know, is ``True``:
    wrongly asking for attention is better than hiding a job that is stuck.
    """
    if not waiting_reason:
        return False
    text = waiting_reason.replace(DRYING_STOP_FAILED_MESSAGE, _DRYING_STOP_FAILED_TOKEN)
    clauses = [part for chunk in text.split(" | ") for part in chunk.split("; ") if part.strip()]
    return not all(_is_automatic_clause(clause) for clause in clauses)
