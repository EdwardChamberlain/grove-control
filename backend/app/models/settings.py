from datetime import datetime

from sqlalchemy import DateTime, String, Text, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class Settings(Base):
    """App settings stored as key-value pairs."""

    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    value: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


async def bool_setting(db: AsyncSession, key: str, default: bool = False) -> bool:
    """A stored "true" flag, or ``default`` while the setting is unset."""
    result = await db.execute(select(Settings).where(Settings.key == key))
    setting = result.scalar_one_or_none()
    return setting.value.lower() == "true" if setting else default
