from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FilamentSkuSettings(Base):
    """User-configured reorder settings for a canonical filament SKU."""

    __tablename__ = "filament_sku_settings"
    __table_args__ = (UniqueConstraint("material", "subtype", "color_hex", name="uq_filament_sku"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material: Mapped[str] = mapped_column(String(50))
    subtype: Mapped[str | None] = mapped_column(String(50))
    brand: Mapped[str | None] = mapped_column(String(100))
    color_hex: Mapped[str | None] = mapped_column(String(9))
    # Legacy/import display metadata only. It is not part of SKU identity.
    color_name: Mapped[str | None] = mapped_column(String(100))
    lead_time_days: Mapped[int] = mapped_column(Integer, default=0)
    safety_margin_value: Mapped[int] = mapped_column(Integer, default=14)
    safety_margin_unit: Mapped[str] = mapped_column(String(10), default="days")
    alerts_snoozed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    @property
    def material_display_name(self) -> str:
        from backend.app.services.filament_material import FilamentMaterial

        return FilamentMaterial.from_parts(
            family=self.material,
            subtype=self.subtype,
            color_hex=self.color_hex,
        ).display_name
