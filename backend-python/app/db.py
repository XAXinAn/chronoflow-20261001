"""数据库接入。

**schema 由 Flyway 独占管理**（迁移文件在 backend-java 下），Python 版只读写不建表，
这样两版共用同一份表结构定义，不存在「两边各写一套 DDL 然后慢慢漂移」的问题。
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(settings.database_url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
