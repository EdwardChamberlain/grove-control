"""Canonical personal-wallet balance calculations."""

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.finance import CostCenter, UserWallet, WalletTransaction


def personal_balance_condition(user_id: int):
    """Return the ledger predicate for a user's personal wallet."""

    return or_(
        WalletTransaction.cost_center_id.is_(None),
        and_(CostCenter.is_private.is_(True), CostCenter.owner_user_id == user_id),
    )


async def calculate_personal_balance(db: AsyncSession, user_id: int) -> float:
    result = await db.execute(
        select(func.coalesce(func.sum(WalletTransaction.amount), 0.0))
        .select_from(WalletTransaction)
        .outerjoin(CostCenter, WalletTransaction.cost_center_id == CostCenter.id)
        .where(
            WalletTransaction.user_id == user_id,
            WalletTransaction.is_voided.is_(False),
            personal_balance_condition(user_id),
        )
    )
    return round(float(result.scalar_one() or 0.0), 2)


async def is_personal_transaction(db: AsyncSession, user_id: int, cost_center_id: int | None) -> bool:
    if cost_center_id is None:
        return True
    result = await db.execute(
        select(CostCenter.is_private, CostCenter.owner_user_id).where(CostCenter.id == cost_center_id)
    )
    center = result.one_or_none()
    return bool(center and center.is_private and center.owner_user_id == user_id)


async def sync_personal_wallet_balance(db: AsyncSession, wallet: UserWallet) -> float:
    balance = await calculate_personal_balance(db, wallet.user_id)
    wallet.balance = balance
    db.add(wallet)
    return balance
