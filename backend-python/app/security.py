"""JWT 签发与校验。

claim 结构与 Java 版逐字段对齐（`scope` / `identityId` / `identityType` / `orgId`），
因此两版签发的令牌可以互换使用——这也是契约一致性的直接体现。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from enum import StrEnum

import jwt

from .config import settings
from .errors import ApiError, ErrorCode


class TokenScope(StrEnum):
    ACCESS = "ACCESS"
    REGISTER = "REGISTER"
    IDENTITY_SELECT = "IDENTITY_SELECT"
    ADMIN = "ADMIN"


@dataclass(frozen=True)
class IdentityPrincipal:
    account_id: int
    identity_id: int
    identity_type: str
    org_id: int | None


@dataclass(frozen=True)
class AdminPrincipal:
    admin_id: int
    username: str
    role: str
    org_id: int | None

    @property
    def is_super_admin(self) -> bool:
        return self.role == "SUPER_ADMIN"


def _encode(payload: dict) -> str:
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def issue_access_token(principal: IdentityPrincipal) -> str:
    now = int(time.time())
    return _encode(
        {
            "iss": settings.jwt_issuer,
            "sub": str(principal.account_id),
            "scope": TokenScope.ACCESS.value,
            "identityId": principal.identity_id,
            "identityType": principal.identity_type,
            "orgId": principal.org_id,
            "iat": now,
            "exp": now + settings.access_token_ttl,
        }
    )


def issue_scoped_token(account_id: int, scope: TokenScope, ttl: int) -> str:
    now = int(time.time())
    return _encode(
        {
            "iss": settings.jwt_issuer,
            "sub": str(account_id),
            "scope": scope.value,
            "iat": now,
            "exp": now + ttl,
        }
    )


def _decode(token: str) -> dict:
    try:
        return jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
        )
    except jwt.ExpiredSignatureError as exc:
        raise ApiError(ErrorCode.TOKEN_EXPIRED, http_status=401) from exc
    except jwt.PyJWTError as exc:
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401) from exc


def parse_access_token(token: str) -> IdentityPrincipal:
    claims = _decode(token)
    if claims.get("scope") != TokenScope.ACCESS.value:
        # 注册令牌 / 选择身份令牌不能访问业务接口
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return IdentityPrincipal(
        account_id=int(claims["sub"]),
        identity_id=int(claims["identityId"]),
        identity_type=claims["identityType"],
        org_id=claims.get("orgId"),
    )


def parse_scoped_token(token: str, expected: TokenScope) -> int:
    claims = _decode(token)
    if claims.get("scope") != expected.value:
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return int(claims["sub"])


def new_token_id() -> str:
    return uuid.uuid4().hex


def issue_admin_token(admin_id: int, username: str, role: str, org_id: int | None) -> str:
    now = int(time.time())
    return _encode(
        {
            "iss": settings.jwt_issuer,
            "sub": str(admin_id),
            "scope": TokenScope.ADMIN.value,
            "username": username,
            "adminRole": role,
            "orgId": org_id,
            "iat": now,
            "exp": now + settings.access_token_ttl,
        }
    )


def parse_admin_token(token: str) -> AdminPrincipal:
    claims = _decode(token)
    if claims.get("scope") != TokenScope.ADMIN.value:
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return AdminPrincipal(
        admin_id=int(claims["sub"]),
        username=claims.get("username") or "",
        role=claims.get("adminRole") or "",
        org_id=claims.get("orgId"),
    )
