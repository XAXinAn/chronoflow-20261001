from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_session
from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.accounts import AccountService, identity_view
from ..wiring import get_account_service, get_auth_service

router = APIRouter(prefix="/api/v1/me", tags=["me"])


class UpdateProfileRequest(BaseModel):
    nickname: str | None = None
    avatarUrl: str | None = None
    timezone: str | None = None


class SetPasswordRequest(BaseModel):
    oldPassword: str | None = None
    newPassword: str = Field(min_length=8, max_length=64)


class NotificationPrefsRequest(BaseModel):
    prefs: dict[str, bool]


@router.get("")
def me(
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
    service=Depends(get_auth_service),
) -> dict:
    views = service.list_identity_views(principal.account_id)
    current = next((view for view in views if view["identity_id"] == principal.identity_id), None)
    if current is None:
        current = identity_view(session, principal.account_id, principal.identity_id)
    return envelope(_camel(current))


@router.patch("")
def update_profile(
    payload: UpdateProfileRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
    service: AccountService = Depends(get_account_service),
) -> dict:
    service.update_profile(principal.identity_id, payload.nickname, payload.avatarUrl, payload.timezone)
    return envelope(identity_view(session, principal.account_id, principal.identity_id))


@router.put("/password")
def set_password(
    payload: SetPasswordRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service: AccountService = Depends(get_account_service),
) -> dict:
    service.set_password(principal.account_id, payload.oldPassword, payload.newPassword)
    return envelope(None)


@router.get("/devices")
def devices(
    principal: IdentityPrincipal = Depends(current_identity),
    service: AccountService = Depends(get_account_service),
) -> dict:
    return envelope(service.devices(principal.identity_id))


@router.delete("/devices/{deviceId}")
def revoke_device(
    deviceId: str,  # noqa: N803 —— 参数名即路径参数名，必须与契约里的 {deviceId} 一致
    principal: IdentityPrincipal = Depends(current_identity),
    service: AccountService = Depends(get_account_service),
) -> dict:
    service.revoke_device(principal.identity_id, deviceId)
    return envelope(None)


@router.put("/notifications")
def update_notifications(
    payload: NotificationPrefsRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service: AccountService = Depends(get_account_service),
) -> dict:
    return envelope(service.update_notification_prefs(principal.identity_id, payload.prefs))


_CAMEL_KEYS = {
    "identity_id": "identityId",
    "identity_type": "identityType",
    "avatar_url": "avatarUrl",
    "org_id": "orgId",
    "org_name": "orgName",
    "department_name": "departmentName",
    "member_no": "memberNo",
    "org_role": "orgRole",
}


def _camel(view: dict) -> dict:
    return {_CAMEL_KEYS.get(key, key): value for key, value in view.items()}
