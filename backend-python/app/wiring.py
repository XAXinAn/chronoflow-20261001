"""依赖装配。"""

from __future__ import annotations

from functools import lru_cache

import redis as redis_lib
from fastapi import Depends
from sqlalchemy.orm import Session

from .db import get_session
from .services.accounts import AccountService
from .services.auth import AuthService
from .store import RefreshTokenStore, VerificationCodeStore, create_redis


@lru_cache(maxsize=1)
def _redis_client() -> redis_lib.Redis:
    return create_redis()


@lru_cache(maxsize=1)
def _code_store() -> VerificationCodeStore:
    return VerificationCodeStore(_redis_client())


@lru_cache(maxsize=1)
def _refresh_store() -> RefreshTokenStore:
    return RefreshTokenStore(_redis_client())


def get_code_store() -> VerificationCodeStore:
    return _code_store()


def get_refresh_store() -> RefreshTokenStore:
    return _refresh_store()


def get_auth_service(session: Session = Depends(get_session)) -> AuthService:
    return AuthService(session, _code_store(), _refresh_store())


def get_account_service(session: Session = Depends(get_session)) -> AccountService:
    return AccountService(session, _refresh_store())
