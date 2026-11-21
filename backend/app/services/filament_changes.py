"""Count the filament changes a print run performed (#337).

A *filament change* is a filament load defined in the sliced G-code: the initial load
at print start plus every change after it. Which printers cut the filament, and which
changes are cutter engagements or manual spool swaps, is the user's knowledge of their
machine; this only counts what the sliced file defines.
"""

from pathlib import Path

from backend.app.utils.threemf_tools import (
    extract_filament_load_count_from_3mf,
    extract_filament_load_layers_from_3mf,
)


def count_run_filament_changes(
    archive_path: Path,
    plate_id: int | None,
    status: str,
    last_layer: int | None,
) -> int | None:
    """Filament changes a run performed, or None when the archive's 3MF can't be read.

    A completed run performed every change in the plate, which the slicer records
    cheaply (no G-code scan). A run that stopped early only performed the loads up to
    the layer it reached, so the G-code is scanned and the scan stops at that layer.
    The initial load always happens, so a partial run with no known layer counts 1
    (what is certain) rather than guessing. Blocking file I/O: call from a thread.
    """
    if not archive_path.is_file():
        return None
    if status == "completed":
        return extract_filament_load_count_from_3mf(archive_path, plate_id)
    layers = extract_filament_load_layers_from_3mf(archive_path, plate_id, max_layer=last_layer or 0)
    return None if layers is None else len(layers)
