"""Canonical filament material value object.

This module keeps material identity separate from vendor colour names.  Print
matching should compare family, subtype, colour, and profile ids; user-facing
labels are derived from those fields instead of catalogue names like
"Jade White" / "Ivory White".
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Any

from backend.app.utils.filament_ids import filament_id_to_setting_id

_FILAMENT_TYPE_GROUPS: tuple[tuple[str, ...], ...] = (("PA-CF", "PA12-CF", "PAHT-CF"),)
_FILAMENT_EQUIV_MAP = {
    filament_type.upper(): group[0].upper() for group in _FILAMENT_TYPE_GROUPS for filament_type in group
}

_KNOWN_FAMILIES: tuple[str, ...] = tuple(
    sorted(
        {
            "PLA-CF",
            "PETG-CF",
            "PETG-HF",
            "PETG HF",
            "PAHT-CF",
            "PA12-CF",
            "PA6-CF",
            "PA-CF",
            "PLA",
            "PETG",
            "ABS",
            "ASA",
            "TPU",
            "PVA",
            "HIPS",
            "PC",
            "PA",
            "PET",
            "NYLON",
        },
        key=len,
        reverse=True,
    )
)

_PROFILE_MATERIAL_LABELS: dict[str, str] = {
    "GFA00": "Bambu PLA Basic",
    "GFA01": "Bambu PLA Matte",
    "GFA02": "Bambu PLA Metal",
    "GFA05": "Bambu PLA Silk",
    "GFA06": "Bambu PLA Silk+",
    "GFA07": "Bambu PLA Marble",
    "GFA08": "Bambu PLA Sparkle",
    "GFA09": "Bambu PLA Tough",
    "GFA11": "Bambu PLA Aero",
    "GFA12": "Bambu PLA Glow",
    "GFA13": "Bambu PLA Dynamic",
    "GFA15": "Bambu PLA Galaxy",
    "GFA16": "Bambu PLA Wood",
    "GFA50": "Bambu PLA-CF",
    "GFB00": "Bambu ABS",
    "GFB01": "Bambu ASA",
    "GFB50": "Bambu ABS-GF",
    "GFC00": "Bambu PC",
    "GFG00": "Bambu PETG Basic",
    "GFG01": "Bambu PETG Translucent",
    "GFG02": "Bambu PETG HF",
    "GFG50": "Bambu PETG-CF",
    "GFG96": "Generic PETG HF",
    "GFG98": "Generic PETG-CF",
    "GFG99": "Generic PETG",
    "GFL95": "Generic PLA High Speed",
    "GFL96": "Generic PLA Silk",
    "GFL98": "Generic PLA-CF",
    "GFL99": "Generic PLA",
    "GFN03": "Bambu PA-CF",
    "GFN04": "Bambu PAHT-CF",
    "GFN05": "Bambu PA6-CF",
    "GFN98": "Generic PA-CF",
    "GFN99": "Generic PA",
    "GFS98": "Generic HIPS",
    "GFS99": "Generic PVA",
    "GFU00": "Bambu TPU 95A HF",
    "GFU01": "Bambu TPU 95A",
    "GFU02": "Bambu TPU for AMS",
    "GFU98": "Generic TPU for AMS",
    "GFU99": "Generic TPU",
}


class MatchScore(IntEnum):
    NO_MATCH = 0
    FAMILY = 100
    MATERIAL_SIMILAR_COLOR = 200
    MATERIAL_COLOR = 300
    PROFILE = 400


def canonical_filament_type(filament_type: str) -> str:
    """Return the material-family identifier used for safe substitutions."""
    upper = (filament_type or "").strip().upper()
    return _FILAMENT_EQUIV_MAP.get(upper, upper)


def normalize_color_hex(value: str | None, *, default: str = "#808080FF") -> str:
    """Normalize colour input to ``#RRGGBBAA``.

    Accepts ``#RRGGBB``, ``RRGGBB``, ``#RRGGBBAA``, or ``RRGGBBAA``. Missing
    alpha becomes ``FF``. Invalid input falls back to the supplied default.
    """
    raw = (value or "").strip().lstrip("#")
    if len(raw) not in (6, 8):
        raw = default.strip().lstrip("#")
    if len(raw) == 6:
        raw += "FF"
    try:
        int(raw, 16)
    except ValueError:
        raw = default.strip().lstrip("#")
        if len(raw) == 6:
            raw += "FF"
    return f"#{raw[:8].upper()}"


def _clean_token(value: str | None) -> str:
    return " ".join((value or "").replace("@", " @ ").split())


def _normalize_subtype(value: str | None) -> str | None:
    subtype = _clean_token((value or "").split("@", 1)[0])
    if not subtype or subtype.upper() in {"GENERIC", "BAMBU", "BAMBU LAB"}:
        return None
    if subtype.startswith("@"):
        return None
    return subtype


def parse_material_label(label: str | None, family_hint: str | None = None) -> tuple[str, str | None]:
    """Parse a slicer/printer material label into ``(family, subtype)``.

    The scanner looks for a known material family anywhere in the label so it
    handles brand-prefixed strings such as ``"Bambu PLA Basic"`` and
    ``"Generic PLA"``. It intentionally stays conservative for unknown labels.
    """
    clean = _clean_token(label)
    hint = _clean_token(family_hint).upper()
    hint_family = ""
    if hint:
        normalized_hint = hint.replace(" ", "-")
        for candidate in _KNOWN_FAMILIES:
            candidate_upper = candidate.upper()
            if normalized_hint == candidate_upper.replace(" ", "-"):
                hint_family = candidate_upper
                break
    if not clean and hint:
        return hint_family or hint, None
    if not clean:
        return "", None

    upper = clean.upper()
    family = ""
    subtype: str | None = None

    if hint_family and (
        upper == hint_family or f" {hint_family} " in f" {upper} " or upper.startswith(f"{hint_family}-")
    ):
        family = hint_family
    else:
        for candidate in _KNOWN_FAMILIES:
            candidate_upper = candidate.upper()
            padded = f" {upper.replace('-', ' - ')} "
            candidate_padded = f" {candidate_upper.replace('-', ' - ')} "
            if upper == candidate_upper or f" {candidate_upper} " in f" {upper} " or candidate_padded in padded:
                family = candidate_upper.replace(" ", "-") if candidate_upper == "PETG-HF" else candidate_upper
                break

    if not family:
        parts = clean.split(" ", 1)
        return parts[0].upper(), _normalize_subtype(parts[1] if len(parts) > 1 else None)

    # Treat PETG-HF as PETG + HF for consistent material labels.
    if family in {"PETG-HF", "PETG HF"}:
        family = "PETG"
        subtype = "HF"

    family_index = upper.find(family)
    if family_index < 0 and family == "PETG":
        family_index = max(upper.find("PETG-HF"), upper.find("PETG HF"))
    if family_index >= 0:
        after = clean[family_index + len(family) :].strip(" -")
        if family == "PETG" and upper[family_index:].startswith(("PETG-HF", "PETG HF")):
            after = clean[family_index + len("PETG-HF") :].strip(" -")
        subtype = _normalize_subtype(after) or subtype

    if hint_family and family == hint_family and not subtype:
        # Brand-prefixed labels such as "Bambu PLA Basic": everything after the
        # family token is the subtype; everything before it is vendor metadata.
        hint_index = upper.find(hint_family)
        if hint_index >= 0:
            subtype = _normalize_subtype(clean[hint_index + len(hint_family) :].strip(" -"))

    return family, subtype


def material_from_profile_id(profile_id: str | None) -> tuple[str, str | None]:
    label = _PROFILE_MATERIAL_LABELS.get((profile_id or "").split("_")[0])
    return parse_material_label(label) if label else ("", None)


def colors_are_similar(color1: str | None, color2: str | None, threshold: int = 40) -> bool:
    """Check if two RGB colours are visually similar within a component threshold."""
    c1 = normalize_color_hex(color1)
    c2 = normalize_color_hex(color2)
    if c1[7:9] == "00" or c2[7:9] == "00":
        return c1[7:9] == c2[7:9] and c1[:7] == c2[:7]
    try:
        return all(abs(int(c1[i : i + 2], 16) - int(c2[i : i + 2], 16)) <= threshold for i in (1, 3, 5))
    except ValueError:
        return False


@dataclass(frozen=True)
class FilamentMaterial:
    family: str
    subtype: str | None
    color_hex: str
    profile_id: str | None = None
    setting_id: str | None = None

    def __post_init__(self) -> None:
        family = (self.family or "").strip().upper()
        subtype = _normalize_subtype(self.subtype)
        profile_family, profile_subtype = material_from_profile_id(self.profile_id)
        if profile_family and (
            not family or canonical_filament_type(family) == canonical_filament_type(profile_family)
        ):
            family = family or profile_family
            subtype = subtype or profile_subtype
        object.__setattr__(self, "family", family)
        object.__setattr__(self, "subtype", subtype)
        object.__setattr__(self, "color_hex", normalize_color_hex(self.color_hex))
        object.__setattr__(self, "profile_id", (self.profile_id or "").strip() or None)
        setting_id = (self.setting_id or "").strip() or None
        if not setting_id and self.profile_id:
            setting_id = filament_id_to_setting_id(self.profile_id)
        object.__setattr__(self, "setting_id", setting_id)

    @classmethod
    def from_parts(
        cls,
        *,
        family: str | None,
        subtype: str | None = None,
        color_hex: str | None = None,
        profile_id: str | None = None,
        setting_id: str | None = None,
    ) -> FilamentMaterial:
        parsed_family, parsed_subtype = parse_material_label(
            " ".join(part for part in [family or "", subtype or ""] if part).strip(),
            family,
        )
        profile_family, profile_subtype = material_from_profile_id(profile_id)
        if profile_family and (
            not parsed_family or canonical_filament_type(parsed_family) == canonical_filament_type(profile_family)
        ):
            parsed_family = parsed_family or profile_family
            parsed_subtype = subtype if subtype is not None else parsed_subtype or profile_subtype
        return cls(
            family=parsed_family or (family or ""),
            subtype=subtype if subtype is not None else parsed_subtype,
            color_hex=color_hex or "#808080FF",
            profile_id=profile_id,
            setting_id=setting_id,
        )

    @classmethod
    def from_ams_tray(cls, tray: dict[str, Any]) -> FilamentMaterial:
        family_hint = tray.get("tray_type") or tray.get("type")
        family, subtype = parse_material_label(tray.get("tray_sub_brands") or family_hint, family_hint)
        return cls(
            family=family,
            subtype=subtype,
            color_hex=tray.get("tray_color") or tray.get("color"),
            profile_id=tray.get("tray_info_idx") or tray.get("profile_id"),
            setting_id=tray.get("setting_id"),
        )

    @classmethod
    def from_3mf_requirement(cls, req: dict[str, Any]) -> FilamentMaterial:
        material = req.get("material")
        if isinstance(material, dict):
            return cls.from_queue_material(material, fallback=req)
        family, subtype = parse_material_label(req.get("tray_sub_brands") or req.get("type"), req.get("type"))
        return cls(
            family=family,
            subtype=subtype,
            color_hex=req.get("color") or req.get("color_hex"),
            profile_id=req.get("tray_info_idx") or req.get("profile_id"),
            setting_id=req.get("setting_id"),
        )

    @classmethod
    def from_spool(cls, spool: Any) -> FilamentMaterial:
        return cls.from_parts(
            family=getattr(spool, "material", None),
            subtype=getattr(spool, "subtype", None),
            color_hex=getattr(spool, "rgba", None),
            profile_id=getattr(spool, "slicer_filament", None),
        )

    @classmethod
    def from_queue_material(
        cls,
        material: dict[str, Any],
        *,
        fallback: dict[str, Any] | None = None,
    ) -> FilamentMaterial:
        fallback = fallback or {}
        return cls.from_parts(
            family=material.get("family") or fallback.get("type"),
            subtype=material.get("subtype"),
            color_hex=material.get("color_hex") or fallback.get("color"),
            profile_id=material.get("profile_id") or fallback.get("tray_info_idx"),
            setting_id=material.get("setting_id") or fallback.get("setting_id"),
        )

    @classmethod
    def from_queue_override(cls, override: dict[str, Any]) -> FilamentMaterial:
        material = override.get("material")
        if isinstance(material, dict):
            return cls.from_queue_material(material, fallback=override)
        return cls.from_parts(
            family=override.get("type") or override.get("family"),
            subtype=override.get("subtype"),
            color_hex=override.get("color") or override.get("color_hex"),
            profile_id=override.get("tray_info_idx") or override.get("profile_id"),
            setting_id=override.get("setting_id"),
        )

    @property
    def family_key(self) -> str:
        return self.family.upper()

    @property
    def compatible_family_key(self) -> str:
        return canonical_filament_type(self.family)

    @property
    def subtype_key(self) -> str:
        return (self.subtype or "").strip().upper()

    @property
    def rgb_hex(self) -> str:
        return self.color_hex[:7]

    @property
    def material_label(self) -> str:
        return " ".join(part for part in [self.family, self.subtype] if part).strip()

    @property
    def generic_color_name(self) -> str:
        if self.color_hex[7:9] == "00":
            return "Clear"
        r = int(self.color_hex[1:3], 16) / 255
        g = int(self.color_hex[3:5], 16) / 255
        b = int(self.color_hex[5:7], 16) / 255
        max_v = max(r, g, b)
        min_v = min(r, g, b)
        lightness = (max_v + min_v) / 2
        saturation = 0.0
        hue = 0.0
        if max_v != min_v:
            delta = max_v - min_v
            saturation = delta / (2 - max_v - min_v) if lightness > 0.5 else delta / (max_v + min_v)
            if max_v == r:
                hue = ((g - b) / delta + (6 if g < b else 0)) / 6
            elif max_v == g:
                hue = ((b - r) / delta + 2) / 6
            else:
                hue = ((r - g) / delta + 4) / 6
        hue *= 360
        if lightness < 0.15:
            return "Black"
        if lightness > 0.85:
            return "White"
        if saturation < 0.15:
            if lightness < 0.4:
                return "Dark Gray"
            if lightness > 0.6:
                return "Light Gray"
            return "Gray"
        if 15 <= hue < 45 and lightness < 0.45:
            return "Brown"
        if 45 <= hue < 70 and lightness < 0.40:
            return "Brown"
        if hue < 15 or hue >= 345:
            return "Red"
        if hue < 45:
            return "Orange"
        if hue < 70:
            return "Yellow"
        if hue < 150:
            return "Green"
        if hue < 200:
            return "Cyan"
        if hue < 260:
            return "Blue"
        if hue < 290:
            return "Purple"
        return "Pink"

    @property
    def display_name(self) -> str:
        return f"{self.material_label or 'Unknown'} - {self.generic_color_name}"

    def to_queue_json(self) -> dict[str, str | None]:
        return {
            "family": self.family,
            "subtype": self.subtype,
            "color_hex": self.color_hex,
            "profile_id": self.profile_id,
            "setting_id": self.setting_id,
        }

    def to_legacy_type_color(self) -> dict[str, str]:
        return {
            "type": self.family,
            "color": self.rgb_hex,
            "tray_info_idx": self.profile_id or "",
        }

    def to_mqtt_fields(self) -> dict[str, str]:
        return {
            "tray_type": self.family,
            "tray_sub_brands": self.material_label or self.family,
            "tray_color": self.color_hex.lstrip("#"),
            "tray_info_idx": self.profile_id or "",
            "setting_id": self.setting_id or "",
        }

    def is_family_match(self, other: FilamentMaterial) -> bool:
        return bool(self.compatible_family_key and self.compatible_family_key == other.compatible_family_key)

    def is_material_match(self, other: FilamentMaterial) -> bool:
        if not self.is_family_match(other):
            return False
        return not self.subtype_key or not other.subtype_key or self.subtype_key == other.subtype_key

    def is_color_match(self, other: FilamentMaterial) -> bool:
        return self.rgb_hex.upper() == other.rgb_hex.upper() and self.color_hex[7:9] == other.color_hex[7:9]

    def is_similar_color(self, other: FilamentMaterial) -> bool:
        return colors_are_similar(self.color_hex, other.color_hex)

    def is_profile_match(self, other: FilamentMaterial) -> bool:
        return bool(self.profile_id and other.profile_id and self.profile_id == other.profile_id)

    def is_exact_match(self, other: FilamentMaterial) -> bool:
        if self.profile_id and other.profile_id:
            return self.is_profile_match(other)
        return self.is_material_match(other) and self.is_color_match(other)

    def compatibility_score(self, other: FilamentMaterial, *, allow_family_fallback: bool = False) -> MatchScore:
        if self.is_profile_match(other):
            return MatchScore.PROFILE
        if self.is_material_match(other) and self.is_color_match(other):
            return MatchScore.MATERIAL_COLOR
        if self.is_material_match(other) and self.is_similar_color(other):
            return MatchScore.MATERIAL_SIMILAR_COLOR
        if allow_family_fallback and self.is_family_match(other):
            return MatchScore.FAMILY
        return MatchScore.NO_MATCH
