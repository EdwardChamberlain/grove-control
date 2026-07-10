"""Canonical filament material value object.

This module keeps material identity separate from vendor colour names. Dispatch
compatibility is family-only; subtype, colour, and profile identifiers remain
available for display, strict colour policy, and printer protocol boundaries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from backend.app.utils.filament_ids import filament_id_to_setting_id

_BRAND_PREFIXES = ("BAMBU LAB", "BAMBU", "GENERIC")


def canonical_filament_type(filament_type: str) -> str:
    """Return a normalized material family identifier.

    Families are intentionally never collapsed into equivalence groups. PAHT-CF,
    PA12-CF, and PA-CF are distinct printable materials.
    """
    return (filament_type or "").strip().upper()


def normalize_color_hex(value: str | None) -> str | None:
    """Normalize colour input to ``#RRGGBBAA``.

    Accepts ``#RRGGBB``, ``RRGGBB``, ``#RRGGBBAA``, or ``RRGGBBAA``. Missing
    alpha becomes ``FF``. Missing or invalid input remains unknown (``None``)
    rather than being converted into a real colour identity.
    """
    raw = (value or "").strip().lstrip("#")
    if len(raw) not in (6, 8):
        return None
    if len(raw) == 6:
        raw += "FF"
    try:
        int(raw, 16)
    except ValueError:
        return None
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


def _strip_brand_prefix(value: str) -> str:
    upper = value.upper()
    for prefix in _BRAND_PREFIXES:
        if upper == prefix:
            return ""
        if upper.startswith(f"{prefix} "):
            return value[len(prefix) :].strip()
    return value


def _canonical_family(value: str | None) -> str:
    return "-".join(_clean_token(value).upper().split())


def _split_family_and_subtype(value: str) -> tuple[str, str | None]:
    family, _, subtype = value.replace("-", " ").partition(" ")
    return _canonical_family(family), _normalize_subtype(subtype)


def parse_material_label(label: str | None, family_hint: str | None = None) -> tuple[str, str | None]:
    """Parse a slicer/printer material label into ``(family, subtype)``.

    An explicit source family (such as an AMS ``tray_type``) is authoritative.
    Labels only contribute optional subtype/display detail after a known brand
    prefix is removed. Without a source family, the first non-brand token is
    used as the family so newly introduced materials do not require code changes.
    """
    clean = _clean_token(label)
    display = _strip_brand_prefix(clean)
    hinted_family = ""
    hinted_subtype = None
    if family_hint:
        hint_display = _strip_brand_prefix(_clean_token(family_hint))
        hinted_family, hinted_subtype = _split_family_and_subtype(hint_display)

    if hinted_family:
        if not display:
            return hinted_family, hinted_subtype
        family_pattern = re.escape(hinted_family).replace(r"\-", r"[- ]+")
        match = re.search(rf"(?<!\w){family_pattern}(?!\w)", display, flags=re.IGNORECASE)
        subtype = _normalize_subtype(display[match.end() :].strip(" -")) if match else hinted_subtype
        return hinted_family, subtype or hinted_subtype
    if not display:
        return "", None
    return _split_family_and_subtype(display)


@dataclass(frozen=True)
class FilamentMaterial:
    family: str
    subtype: str | None
    color_hex: str | None
    profile_id: str | None = None
    setting_id: str | None = None

    def __post_init__(self) -> None:
        family = (self.family or "").strip().upper()
        subtype = _normalize_subtype(self.subtype)
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
            family if subtype is not None else None,
        )
        return cls(
            family=parsed_family or (family or ""),
            subtype=subtype if subtype is not None else parsed_subtype,
            color_hex=color_hex,
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
        family, subtype = parse_material_label(req.get("tray_sub_brands") or req.get("type"))
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
    def rgb_hex(self) -> str | None:
        return self.color_hex[:7] if self.color_hex else None

    @property
    def material_label(self) -> str:
        return " ".join(part for part in [self.family, self.subtype] if part).strip()

    @property
    def generic_color_name(self) -> str:
        if not self.color_hex:
            return "Unknown colour"
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

    def to_api_json(self) -> dict[str, str | None]:
        """Serialize canonical identity together with backend-owned display text."""
        return {
            **self.to_queue_json(),
            "material_label": self.material_label,
            "display_name": self.display_name,
            "generic_color_name": self.generic_color_name,
        }

    def to_legacy_type_color(self) -> dict[str, str]:
        return {
            "type": self.family,
            "color": self.rgb_hex or "",
            "tray_info_idx": self.profile_id or "",
        }

    def to_mqtt_fields(self) -> dict[str, str]:
        return {
            "tray_type": self.family,
            "tray_sub_brands": self.material_label or self.family,
            "tray_color": (self.color_hex or "").lstrip("#"),
            "tray_info_idx": self.profile_id or "",
            "setting_id": self.setting_id or "",
        }

    def is_family_match(self, other: FilamentMaterial) -> bool:
        return bool(self.compatible_family_key and self.compatible_family_key == other.compatible_family_key)

    def is_material_match(self, other: FilamentMaterial) -> bool:
        """Return whether two materials have the same family and subtype identity."""
        return self.is_family_match(other) and self.subtype_key == other.subtype_key

    def is_dispatch_compatible(self, other: FilamentMaterial) -> bool:
        """Return whether a loaded material has the same material family.

        Dispatch deliberately ignores subtype and profile. They describe the
        selected printer/slicer settings, not whether PLA can be substituted
        for PLA. Colour policy is evaluated separately by the caller.
        """
        return self.is_family_match(other)

    def is_color_match(self, other: FilamentMaterial) -> bool:
        return bool(self.color_hex and other.color_hex and self.color_hex == other.color_hex)

    def is_profile_match(self, other: FilamentMaterial) -> bool:
        return bool(self.profile_id and other.profile_id and self.profile_id == other.profile_id)

    def is_exact_match(self, other: FilamentMaterial) -> bool:
        return self.is_material_match(other) and self.is_color_match(other)
