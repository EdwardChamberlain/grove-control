"""Typed API contracts for canonical filament material workflows."""

from typing import Any, Literal

from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator


class FilamentMaterialResponse(BaseModel):
    family: str = Field(min_length=1)
    subtype: str | None = None
    color_hex: str | None = Field(default=None, pattern=r"^#[0-9A-F]{8}$")
    profile_id: str | None = None
    setting_id: str | None = None

    @field_validator("family")
    @classmethod
    def family_must_be_canonical(cls, value: str) -> str:
        normalized = value.strip().upper()
        if value != normalized:
            raise ValueError("family must be uppercase and whitespace-free")
        return value


class FilamentMaterialViewResponse(FilamentMaterialResponse):
    material_label: str
    display_name: str
    generic_color_name: str


class FilamentRequirementRequest(BaseModel):
    slot_id: int
    type: str = ""
    color: str | None = None
    material: FilamentMaterialResponse | None = None
    tray_info_idx: str | None = None
    nozzle_id: int | None = None
    used_grams: float | None = None
    used_meters: float | None = None

    def as_legacy_dict(self) -> dict[str, Any]:
        data = self.model_dump(exclude_none=True)
        if self.material:
            data["material"] = self.material.model_dump(exclude_none=True)
        return data


class QueueFilamentOverrideRequest(BaseModel):
    """Canonical client intent for one queued sliced-material slot.

    Legacy fields remain optional only while third-party API clients migrate.
    The server reconstructs persisted legacy fields from ``material``.
    """

    slot_id: int
    material: FilamentMaterialResponse | None = None
    force_color_match: StrictBool | None = None
    type: str | None = None
    color: str | None = None
    tray_info_idx: str | None = None

    @model_validator(mode="after")
    def explicit_force_color_match_must_not_be_null(self) -> "QueueFilamentOverrideRequest":
        if "force_color_match" in self.model_fields_set and self.force_color_match is None:
            raise ValueError("force_color_match must be a boolean")
        return self

    def to_override_dict(self) -> dict[str, Any]:
        data = self.model_dump(exclude_none=True)
        if "force_color_match" in self.model_fields_set:
            data["force_color_match"] = self.force_color_match
        return data


class QueueFilamentOverrideResponse(BaseModel):
    """Canonical queue metadata returned to clients during the transition."""

    slot_id: int
    material: FilamentMaterialResponse
    force_color_match: bool = True
    type: str | None = None
    color: str | None = None
    tray_info_idx: str | None = None


class FilamentMappingPreviewRequest(BaseModel):
    filaments: list[FilamentRequirementRequest] = Field(default_factory=list)
    manual_mappings: dict[int, int] = Field(default_factory=dict)
    force_color_match: bool = True


class FilamentMappingLoadedFilamentResponse(BaseModel):
    global_tray_id: int
    ams_id: int
    tray_id: int
    is_ht: bool
    is_external: bool
    extruder_id: int | None = None
    remain: float = -1
    material: FilamentMaterialViewResponse


class FilamentMappingComparisonResponse(BaseModel):
    slot_id: int
    material: FilamentMaterialViewResponse
    status: Literal["match", "material_only", "missing"]
    mapped_tray_id: int
    candidate_tray_ids: list[int]


class FilamentMappingPreviewResponse(BaseModel):
    auto_mapping: list[int] | None = None
    mapping: list[int] | None = None
    loaded_filaments: list[FilamentMappingLoadedFilamentResponse]
    comparisons: list[FilamentMappingComparisonResponse]


class ModelFilamentOptionsRequest(BaseModel):
    model: str
    location: str | None = None
    filaments: list[FilamentRequirementRequest] = Field(default_factory=list)


class ModelFilamentOptionResponse(BaseModel):
    material: FilamentMaterialViewResponse


class ModelFilamentSlotOptionsResponse(BaseModel):
    slot_id: int
    material: FilamentMaterialViewResponse
    options: list[ModelFilamentOptionResponse]


class ModelFilamentOptionsResponse(BaseModel):
    slots: list[ModelFilamentSlotOptionsResponse]
