"""FastAPI 依赖：身份解析与幂等前置校验。"""

from __future__ import annotations

from fastapi import Depends, Header, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .errors import ApiError, ErrorCode
from .security import (
    AdminPrincipal,
    IdentityPrincipal,
    parse_access_token,
    parse_admin_token,
    parse_scoped_token,
    TokenScope,
)

# 用 HTTPBearer 而不是手工读 Header：这样 OpenAPI 才会为受保护接口
# 自动生成 security 声明，与 Java 版的 @SecurityRequirement 等价。
bearer_scheme = HTTPBearer(auto_error=False)


def current_identity(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
) -> IdentityPrincipal:
    if credentials is None or not credentials.credentials:
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return parse_access_token(credentials.credentials)


def authorization_header(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return authorization[len("Bearer ") :].strip()


def register_account_id(authorization: str | None = Header(default=None)) -> int:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return parse_scoped_token(authorization[len("Bearer ") :].strip(), TokenScope.REGISTER)


def current_admin(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
) -> AdminPrincipal:
    if credentials is None or not credentials.credentials:
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    return parse_admin_token(credentials.credentials)


def current_super_admin(principal: AdminPrincipal = Depends(current_admin)) -> AdminPrincipal:
    if not principal.is_super_admin:
        raise ApiError(ErrorCode.FORBIDDEN, "该操作需要平台超管权限")
    return principal
