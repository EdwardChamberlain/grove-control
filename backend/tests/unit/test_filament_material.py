import json
from pathlib import Path

from backend.app.core.database import _canonicalize_queue_filament_overrides_payload
from backend.app.services.filament_material import FilamentMaterial, normalize_color_hex, parse_material_label

_CONTRACT = json.loads((Path(__file__).parents[3] / "shared" / "filament-material-contract.json").read_text())


def test_normalize_color_hex_adds_opaque_alpha():
    assert normalize_color_hex("#FFFFFF") == "#FFFFFFFF"
    assert normalize_color_hex("00000000") == "#00000000"


def test_display_name_uses_generic_color_not_catalogue_name():
    material = FilamentMaterial.from_parts(family="PLA", subtype="Matte", color_hex="#FFFFFF", profile_id="GFA01")
    assert material.display_name == "PLA Matte - White"
    assert material.generic_color_name == "White"


def test_profile_id_derives_bambu_subtype_from_plain_3mf_requirement():
    matte = FilamentMaterial.from_3mf_requirement({"type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA01"})
    basic = FilamentMaterial.from_3mf_requirement({"type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA00"})

    assert matte.material_label == "PLA Matte"
    assert basic.material_label == "PLA Basic"
    assert matte.is_family_match(basic)
    assert not matte.is_material_match(basic)
    assert matte.is_dispatch_compatible(basic)
    assert not basic.is_dispatch_compatible(
        FilamentMaterial.from_parts(family="PLA", subtype="Silk", color_hex="#FFFFFF")
    )


def test_profile_id_derives_extended_bambu_subtype():
    glow = FilamentMaterial.from_3mf_requirement({"type": "PLA", "color": "#FFFFFF", "tray_info_idx": "GFA12"})

    assert glow.material_label == "PLA Glow"


def test_profile_fallbacks_match_the_cross_runtime_contract():
    for profile in _CONTRACT["profiles"]:
        material = FilamentMaterial.from_3mf_requirement(
            {"type": profile["family"], "color": "#FFFFFF", "tray_info_idx": profile["id"]}
        )
        assert (material.family, material.subtype) == (profile["family"], profile["subtype"])


def test_dispatch_compatibility_matches_the_cross_runtime_contract():
    for case in _CONTRACT["dispatch_compatibility"]:
        left = FilamentMaterial.from_parts(color_hex="#FFFFFF", **case["left"])
        right = FilamentMaterial.from_parts(color_hex="#FFFFFF", **case["right"])
        assert left.is_dispatch_compatible(right) is case["compatible"]


def test_parse_material_label_handles_brand_prefixes_and_hf():
    assert parse_material_label("Bambu PLA Basic") == ("PLA", "Basic")
    assert parse_material_label("Bambu PLA Basic @BBL X1C") == ("PLA", "Basic")
    assert parse_material_label("PLA Matte", "PLA Matte") == ("PLA", "Matte")
    assert parse_material_label("Generic PLA") == ("PLA", None)
    assert parse_material_label("PETG-HF") == ("PETG", "HF")
    assert parse_material_label("TPU 95A") == ("TPU", "95A")


def test_requirement_type_can_be_full_material_label():
    material = FilamentMaterial.from_3mf_requirement({"type": "PLA Matte", "color": "#FFFFFF"})

    assert material.family == "PLA"
    assert material.subtype == "Matte"
    assert material.display_name == "PLA Matte - White"


def test_queue_override_backfill_writes_material_and_removes_color_name():
    payload = json.dumps(
        [{"slot_id": 1, "type": "PLA", "color": "#FFFFFF", "color_name": "Jade White", "force_color_match": True}]
    )

    normalized = _canonicalize_queue_filament_overrides_payload(payload)
    data = json.loads(normalized or "[]")

    assert data == [
        {
            "slot_id": 1,
            "force_color_match": True,
            "material": {
                "family": "PLA",
                "subtype": None,
                "color_hex": "#FFFFFFFF",
                "profile_id": None,
                "setting_id": None,
            },
            "type": "PLA",
            "color": "#FFFFFF",
            "tray_info_idx": "",
        }
    ]


def test_queue_override_backfill_does_not_synthesize_missing_color():
    payload = json.dumps([{"slot_id": 1, "type": "PLA", "force_color_match": True}])

    assert _canonicalize_queue_filament_overrides_payload(payload) == payload
