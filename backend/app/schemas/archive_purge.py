"""Schemas for archive auto-purge (#1008 follow-up)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ArchivePurgePreviewResponse(BaseModel):
    count: int
    total_bytes: int
    sample_filenames: list[str]
    mode: Literal["age", "count"] = "age"
    older_than_days: int | None = None
    keep_count: int | None = None


class ArchivePurgeRequest(BaseModel):
    older_than_days: int | None = Field(default=None, ge=1, le=3650)
    keep_count: int | None = Field(
        default=None,
        ge=1,
        le=100_000,
    )
    # #1390: parity with single-archive delete. False (default) soft-deletes
    # — files off disk, archive row hidden, Quick Stats preserved. True
    # also drops PrintLogEntry rows so the contribution leaves /stats.
    purge_stats: bool = False

    @model_validator(mode="after")
    def validate_retention_target(self):
        if (self.older_than_days is None) == (self.keep_count is None):
            raise ValueError("Specify exactly one of older_than_days or keep_count")
        return self


class ArchivePurgeResponse(BaseModel):
    deleted: int
    purge_stats: bool = False


class ArchivePurgeSettings(BaseModel):
    enabled: bool = False
    days: int = Field(default=365, ge=7, le=3650)
    # Existing installs and clients default to the unchanged age policy.
    mode: Literal["age", "count"] = "age"
    max_count: int = Field(
        default=100,
        ge=1,
        le=100_000,
    )
    # #1390: scheduled-purge equivalent of the single-delete checkbox.
    # Default False — preserves Quick Stats; flip to True to also drop
    # the contribution from /stats every time the sweeper runs.
    purge_stats: bool = False
