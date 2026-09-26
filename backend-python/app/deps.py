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


def current_org_actor(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
):
    """组织管理端（``/org-admin/**``）的令牌（spec §3.2 / §4.3）。

    既接受后台组织管理员的 ``ADMIN`` 令牌，也接受 App 里组织身份的 ``ACCESS`` 令牌——
    两条入口通向同一个角色。之所以必须有后台这一条：新组织建好时成员数为 0，
    若管理入口只能由成员发起，新组织就永远开不了张。

    这里只是把令牌解析出主体；「是不是这个组织的管理员」由 Service 层判定。
    """
    if credentials is None or not credentials.credentials:
        raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
    token = credentials.credentials
    try:
        return parse_admin_token(token)
    except ApiError:
        # 不是后台令牌就按 C 端身份解析；两条都失败时抛 401
        return parse_access_token(token)


def current_super_admin(principal: AdminPrincipal = Depends(current_admin)) -> AdminPrincipal:
    if not principal.is_super_admin:
        raise ApiError(ErrorCode.FORBIDDEN, "该操作需要平台超管权限")
    return principal
