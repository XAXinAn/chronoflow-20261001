"""推送设备注册（spec §4.5）。

App 在极光 SDK 初始化拿到 registrationId 后调这里上报；服务端才知道
「组织日程下发给这些人」时往哪几台设备发。

注意与 `/me/devices` 的区别：那个是**登录会话**（刷新令牌），这个是**推送标识**。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity
from ..errors import ApiError, ErrorCode, envelope
from ..security import IdentityPrincipal
from ..services.push import PushDeviceService

router = APIRouter(prefix="/api/v1/me/push-devices", tags=["push"])


class PushDeviceRequest(BaseModel):
    registrationId: str = Field(min_length=1, max_length=128)
    platform: str | None = None
    appVersion: str | None = Field(default=None, max_length=32)


@router.post("")
def register(
    payload: PushDeviceRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    service = PushDeviceService(session)
    try:
        device = service.register(
            principal.account_id, principal.identity_id,
            payload.registrationId, payload.platform, payload.appVersion,
        )
    except ValueError as exc:
        raise ApiError(ErrorCode.PARAM_INVALID, str(exc)) from exc
    return envelope(_camel(device))


@router.delete("/{registrationId}")
def unregister(
    registrationId: str,  # noqa: N803 —— 参数名即路径参数名，必须与契约一致
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    service = PushDeviceService(session)
    try:
        service.unregister(principal.account_id, registrationId)
    except ValueError as exc:
        raise ApiError(ErrorCode.PARAM_INVALID, str(exc)) from exc
    return envelope(None)


@router.get("")
def list_devices(
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    return envelope([_camel(row) for row in PushDeviceService(session).list_mine(principal.account_id)])


_CAMEL = {
    "registration_id": "registrationId",
    "app_version": "appVersion",
    "created_at": "createdAt",
    "updated_at": "updatedAt",
}


def _camel(row: dict) -> dict:
    return {_CAMEL.get(key, key): value for key, value in row.items()}
