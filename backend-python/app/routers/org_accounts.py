"""组织账号的绑定与解绑（spec §3.2 / §4.2.5）。

全部用**个人身份**的令牌调用：管理的是「我这个个人账号绑定了哪些组织账号」。
组织身份的数据接口在 /org/**，用组织身份的令牌。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.auth import AuthService
from ..services.org_account import OrgAccountService
from ..wiring import get_auth_service, get_refresh_store

router = APIRouter(prefix="/api/v1/org-accounts", tags=["org-accounts"])


class OrgAccountLinkRequest(BaseModel):
    """组织唯一 ID（组织编码或数字 ID 均可）+ 成员唯一识别 ID（学号/工号）。"""

    org: str = Field(min_length=1)
    memberKey: str = Field(min_length=1)


def _service(
    session: Session = Depends(get_session), auth: AuthService = Depends(get_auth_service)
) -> OrgAccountService:
    return OrgAccountService(session, auth, get_refresh_store())


@router.post("/login")
def login(
    payload: OrgAccountLinkRequest,
    deviceId: str = Query(min_length=1),
    principal: IdentityPrincipal = Depends(current_identity),
    service: OrgAccountService = Depends(_service),
) -> dict:
    """登录组织账号并绑定；返回该组织身份的令牌对，App 存进组织账号列表。"""
    service.require_personal(principal)
    return envelope(service.login(principal.account_id, payload.org, payload.memberKey, deviceId))


@router.get("")
def list_accounts(
    principal: IdentityPrincipal = Depends(current_identity),
    service: OrgAccountService = Depends(_service),
) -> dict:
    service.require_personal(principal)
    return envelope(service.list(principal.account_id))


@router.delete("/{identityId}")
def unlink(
    identityId: int,
    principal: IdentityPrincipal = Depends(current_identity),
    service: OrgAccountService = Depends(_service),
) -> dict:
    """解绑：删除这台账号上的登录记录（组织侧成员记录保留，可重新认领）。"""
    service.require_personal(principal)
    service.unlink(principal.account_id, identityId)
    return envelope(None)
