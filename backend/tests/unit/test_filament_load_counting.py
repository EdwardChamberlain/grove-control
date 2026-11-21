"""Golden-file and unit tests for filament-change counting (#337).

A *filament change* is a filament load defined in the sliced G-code: the initial load at
print start plus every change after it. Real sliced plates live in
``tests/_fixtures/threemf`` with hand-derived expectations in ``manifest.json``.

Two independent sources must agree with the manifest for every file:

* ``filament_sequence.json`` - the fast path (no G-code scan), and
* the G-code itself - the ground truth for what the printer executes.

If a slicer update changes either, or the two drift apart, these fail.
"""

import io
import json
import zipfile
from pathlib import Path

import pytest

from backend.app.services.filament_changes import count_run_filament_changes
from backend.app.utils.threemf_tools import (
    extract_filament_load_count_from_3mf,
    extract_filament_load_layers_from_3mf,
    parse_gcode_filament_load_layers,
)

FIXTURES = Path(__file__).resolve().parent.parent / "_fixtures" / "threemf"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())["files"]
GOLDEN = sorted(MANIFEST)


def _rewrite(source: Path, dest: Path, *, drop: tuple[str, ...] = (), replace: dict[str, bytes] | None = None) -> Path:
    """Copy a 3MF, optionally removing or replacing members."""
    replace = replace or {}
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            if info.filename in drop:
                continue
            out.writestr(info.filename, replace.get(info.filename, src.read(info.filename)))
    return dest


def _plate_3mf(path: Path, plates: dict[int, tuple[list[int] | None, str]]) -> Path:
    """Build a minimal multi-plate 3MF. plates = {plate: (sequence or None, gcode)}."""
    sequences = {f"plate_{n}": {"sequence": seq} for n, (seq, _) in plates.items() if seq is not None}
    with zipfile.ZipFile(path, "w") as zf:
        if sequences:
            zf.writestr("Metadata/filament_sequence.json", json.dumps(sequences))
        for n, (_, gcode) in plates.items():
            zf.writestr(f"Metadata/plate_{n}.gcode", gcode)
    return path


class TestGoldenFiles:
    def test_every_fixture_has_a_manifest_entry_and_vice_versa(self):
        on_disk = sorted(p.name for p in FIXTURES.glob("*.3mf"))
        assert on_disk == GOLDEN, "a fixture without an expectation (or an expectation without a file) is untested"

    @pytest.mark.parametrize("name", GOLDEN)
    def test_expectation_follows_the_definition(self, name):
        """Loads are the programmed changes plus the initial load, by construction."""
        entry = MANIFEST[name]
        assert entry["expected_loads"] == entry["programmed_changes"] + 1

    @pytest.mark.parametrize("name", GOLDEN)
    def test_fast_source_matches_expectation(self, name):
        assert (
            extract_filament_load_count_from_3mf(FIXTURES / name, MANIFEST[name]["plate"])
            == (MANIFEST[name]["expected_loads"])
        )

    @pytest.mark.parametrize("name", GOLDEN)
    def test_gcode_ground_truth_matches_expectation(self, name):
        layers = extract_filament_load_layers_from_3mf(FIXTURES / name, MANIFEST[name]["plate"])
        assert layers is not None
        assert len(layers) == MANIFEST[name]["expected_loads"]

    @pytest.mark.parametrize("name", GOLDEN)
    def test_loads_are_ordered_and_start_at_layer_zero(self, name):
        layers = extract_filament_load_layers_from_3mf(FIXTURES / name, MANIFEST[name]["plate"])
        assert layers[0] == 0
        assert layers == sorted(layers)

    @pytest.mark.parametrize(
        ("name", "max_layer", "expected"), [(n, m, e) for n in GOLDEN for m, e in MANIFEST[n]["layer_checks"]]
    )
    def test_partial_print_counts_only_the_loads_reached(self, name, max_layer, expected):
        layers = extract_filament_load_layers_from_3mf(FIXTURES / name, MANIFEST[name]["plate"], max_layer=max_layer)
        assert len(layers) == expected

    @pytest.mark.parametrize("name", GOLDEN)
    def test_gcode_fallback_agrees_when_the_sequence_file_is_missing(self, name, tmp_path):
        stripped = _rewrite(FIXTURES / name, tmp_path / "stripped.3mf", drop=("Metadata/filament_sequence.json",))
        assert (
            extract_filament_load_count_from_3mf(stripped, MANIFEST[name]["plate"]) == MANIFEST[name]["expected_loads"]
        )

    def test_slice_info_layer_ranges_are_not_a_valid_source(self):
        """Painted changes happen inside layers, so per-layer ranges undercount them.

        Pinned so nobody 'simplifies' the counter onto slice_info.config later.
        """
        with zipfile.ZipFile(FIXTURES / "cylinder_painted_74_changes.3mf") as zf:
            slice_info = zf.read("Metadata/slice_info.config").decode()
        assert slice_info.count("<layer_filament_list ") < MANIFEST["cylinder_painted_74_changes.3mf"]["expected_loads"]


class TestFilamentSequenceFallbacks:
    @pytest.mark.parametrize(
        "content",
        [b"not json", b"[]", b'{"plate_1": {"sequence": []}}', b'{"plate_1": {"sequence": ["a"]}}', b'{"plate_1": 5}'],
    )
    def test_unusable_sequence_file_falls_back_to_the_gcode(self, content, tmp_path):
        broken = _rewrite(
            FIXTURES / "cylinder_2_changes.3mf",
            tmp_path / "broken.3mf",
            replace={"Metadata/filament_sequence.json": content},
        )
        assert extract_filament_load_count_from_3mf(broken, 1) == 3

    def test_unreadable_file_is_unknown_not_zero(self, tmp_path):
        bad = tmp_path / "bad.3mf"
        bad.write_bytes(b"not a zip")
        assert extract_filament_load_count_from_3mf(bad, 1) is None
        assert extract_filament_load_layers_from_3mf(bad, 1) is None

    def test_no_gcode_and_no_sequence_is_unknown(self, tmp_path):
        empty = tmp_path / "empty.3mf"
        with zipfile.ZipFile(empty, "w") as zf:
            zf.writestr("Metadata/slice_info.config", "<config/>")
        assert extract_filament_load_count_from_3mf(empty, 1) is None


class TestPlateSelection:
    def test_each_plate_of_a_multi_plate_file_counts_its_own_loads(self, tmp_path):
        plate_1 = "M620 S0A\nM73 L5\nM620 S1A\nM620 S255\n"
        plate_2 = "M620 S0A\nM73 L3\nM620 S1A\nM73 L9\nM620 S0A\nM620 S255\n"
        path = _plate_3mf(tmp_path / "multi.3mf", {1: ([1, 2], plate_1), 2: ([1, 2, 1], plate_2)})

        assert extract_filament_load_count_from_3mf(path, 1) == 2
        assert extract_filament_load_count_from_3mf(path, 2) == 3
        assert extract_filament_load_layers_from_3mf(path, 2) == [0, 3, 9]

    def test_sequence_and_gcode_both_select_the_same_plate(self, tmp_path):
        """A plate must never be counted from another plate's sequence or G-code."""
        path = _plate_3mf(tmp_path / "multi.3mf", {1: ([1], "M620 S0A\n"), 2: ([1, 2], "M620 S0A\nM620 S1A\n")})
        stripped = _rewrite(path, tmp_path / "no-seq.3mf", drop=("Metadata/filament_sequence.json",))

        assert extract_filament_load_count_from_3mf(path, 2) == extract_filament_load_count_from_3mf(stripped, 2) == 2

    def test_missing_plate_is_unknown_rather_than_another_plate(self, tmp_path):
        path = _plate_3mf(tmp_path / "multi.3mf", {1: (None, "M620 S0A\n"), 2: (None, "M620 S0A\nM620 S1A\n")})
        assert extract_filament_load_count_from_3mf(path, 3) is None

    def test_no_plate_requested_uses_the_only_plate(self, tmp_path):
        path = _plate_3mf(tmp_path / "single.3mf", {1: ([1, 2, 1], "M620 S0A\n")})
        assert extract_filament_load_count_from_3mf(path) == 3

    def test_no_plate_requested_with_several_plates_uses_the_lowest(self, tmp_path):
        path = _plate_3mf(tmp_path / "multi.3mf", {2: (None, "M620 S0A\nM620 S1A\n"), 1: (None, "M620 S0A\n")})
        assert extract_filament_load_count_from_3mf(path) == 1


class TestGcodeParser:
    def test_counts_loads_not_unloads_or_mode_lines(self):
        gcode = "M620 M\nM620 S0A   ; switch material\nM621 S0A\nM620.1 E F548 T240\nM620 S255\nM621 S255\n"
        assert parse_gcode_filament_load_layers(gcode.splitlines()) == [0]

    def test_an_unload_with_the_load_suffix_is_still_an_unload(self):
        assert parse_gcode_filament_load_layers(["M620 S255A"]) == []

    def test_layer_comes_from_the_preceding_layer_marker(self):
        gcode = ["M620 S0A", "M73 L4", "M620 S1A", "M73 P50 R3", "M73.2 R1.0", "M73 L9", "M620 S0A"]
        assert parse_gcode_filament_load_layers(gcode) == [0, 4, 9]

    def test_progress_only_m73_lines_do_not_move_the_layer(self):
        assert parse_gcode_filament_load_layers(["M73 L2", "M73 P90 R1", "M620 S1A"]) == [2]

    def test_scan_stops_after_the_layer_limit(self):
        seen = []

        def lines():
            for line in ["M620 S0A", "M73 L5", "M620 S1A", "M73 L6", "M620 S0A", "M73 L7", "M620 S1A"]:
                seen.append(line)
                yield line

        assert parse_gcode_filament_load_layers(lines(), max_layer=5) == [0, 5]
        # It reads up to and including the first marker beyond the limit (L6), then stops.
        assert seen == ["M620 S0A", "M73 L5", "M620 S1A", "M73 L6"]

    def test_multi_digit_and_indented_filament_ids(self):
        assert parse_gcode_filament_load_layers(["  M620 S12A", "M620 S4A"]) == [0, 0]

    def test_no_filament_commands_is_zero_loads(self):
        assert parse_gcode_filament_load_layers(["G1 X1 Y1 E1", "M73 L2"]) == []

    def test_accepts_any_iterable_of_lines(self):
        assert parse_gcode_filament_load_layers(io.StringIO("M620 S0A\nM73 L3\nM620 S1A\n")) == [0, 3]


class TestCountRunFilamentChanges:
    two_changes = FIXTURES / "cylinder_2_changes.3mf"

    def test_completed_run_counts_every_load(self):
        assert count_run_filament_changes(self.two_changes, 1, "completed", 127) == 3

    def test_completed_run_ignores_the_layer(self):
        assert count_run_filament_changes(self.two_changes, 1, "completed", None) == 3

    @pytest.mark.parametrize("status", ["failed", "aborted", "cancelled"])
    def test_stopped_run_counts_only_the_loads_it_reached(self, status):
        assert count_run_filament_changes(self.two_changes, 1, status, 60) == 2
        assert count_run_filament_changes(self.two_changes, 1, status, 96) == 3

    def test_stopped_run_before_the_first_change_counts_the_initial_load_only(self):
        assert count_run_filament_changes(self.two_changes, 1, "failed", 10) == 1

    @pytest.mark.parametrize("layer", [None, 0])
    def test_stopped_run_with_no_known_layer_counts_what_is_certain(self, layer):
        assert count_run_filament_changes(self.two_changes, 1, "cancelled", layer) == 1

    def test_missing_file_is_unknown(self, tmp_path):
        assert count_run_filament_changes(tmp_path / "gone.3mf", 1, "completed", None) is None

    def test_a_directory_is_not_a_file(self, tmp_path):
        assert count_run_filament_changes(tmp_path, None, "completed", None) is None

    def test_unreadable_3mf_is_unknown(self, tmp_path):
        bad = tmp_path / "bad.3mf"
        bad.write_bytes(b"nope")
        assert count_run_filament_changes(bad, 1, "completed", None) is None
        assert count_run_filament_changes(bad, 1, "failed", 5) is None
