"""SQLAlchemy 模型。

只映射当前实现用到的列；其余列由数据库默认值承担。
表结构完全来自 Flyway 迁移，本文件不负责建表。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Account(Base):
    """账号表。

    ⚠️ 这里有个容易踩的点：只要映射了某列却没给 ``server_default``，
    SQLAlchemy 就会在 INSERT 时显式写入 NULL，**覆盖掉数据库的 DEFAULT**。
    因此凡是「值由数据库生成」的列都必须声明 server_default。
    """

    __tablename__ = "account"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    phone: Mapped[str] = mapped_column(String(20))
    password_hash: Mapped[str | None] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(128))
    wechat_unionid: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class Identity(Base):
    __tablename__ = "identity"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_id: Mapped[int] = mapped_column(BigInteger)
    identity_type: Mapped[str] = mapped_column(String(16))
    org_id: Mapped[int | None] = mapped_column(BigInteger)
    nickname: Mapped[str | None] = mapped_column(String(64))
    avatar_url: Mapped[str | None] = mapped_column(String(512))
    timezone: Mapped[str | None] = mapped_column(String(64))
    # 该列是 jsonb；用 JSONB 类型而不是 String，否则 psycopg 会按 varchar 发送而被数据库拒绝
    notification_prefs: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE")
