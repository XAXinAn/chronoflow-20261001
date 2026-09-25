from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity, register_account_id
from ..errors import envelope
from ..security import TokenScope, parse_scoped_token
from ..services.auth import AuthService
from ..store import RefreshTokenStore
from ..wiring import get_auth_service, get_refresh_store

router = APIRouter(prefix="/api/v1", tags=["auth"])

PHONE_PATTERN = r"^1[3-9]\d{9}$"


class SendSmsCodeRequest(BaseModel):
    phone: str = Field(pattern=PHONE_PATTERN)


class SmsLoginRequest(BaseModel):
    phone: str = Field(pattern=PHONE_PATTERN)
    code: str = Field(min_length=1)


class PasswordLoginRequest(BaseModel):
    phone: str = Field(pattern=PHONE_PATTERN)
    password: str = Field(min_length=1)


class IdentitySelectRequest(BaseModel):
    selectToken: str
    identityId: int
    deviceId: str | None = None
    deviceName: str | None = None


class SwitchIdentityRequest(BaseModel):
    refreshToken: str
    targetIdentityId: int
    deviceId: str | None = None


class RefreshTokenRequest(BaseModel):
    refreshToken: str
    deviceId: str | None = None


class LogoutRequest(BaseModel):
    refreshToken: str | None = None


class CreatePersonalIdentityRequest(BaseModel):
    nickname: str | None = None
    avatarUrl: str | None = None
    deviceId: str | None = None


@router.post("/auth/sms/code")
def send_sms_code(
    payload: SendSmsCodeRequest,
    request: Request,
    service: AuthService = Depends(get_auth_service),
) -> dict:
    forwarded = request.headers.get("x-forwarded-for")
    client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else None)
    return envelope(service.send_sms_code(payload.phone, client_ip))


@router.post("/auth/login/sms")
def login_by_sms(payload: SmsLoginRequest, service: AuthService = Depends(get_auth_service)) -> dict:
    return envelope(service.login_by_sms(payload.phone, payload.code))


@router.post("/auth/login/password")
def login_by_password(
    payload: PasswordLoginRequest, service: AuthService = Depends(get_auth_service)
) -> dict:
    return envelope(service.login_by_password(payload.phone, payload.password))


@router.post("/auth/identity/select")
def select_identity(
    payload: IdentitySelectRequest, service: AuthService = Depends(get_auth_service)
) -> dict:
    account_id = parse_scoped_token(payload.selectToken, TokenScope.IDENTITY_SELECT)
    return envelope(service.select_identity(account_id, payload.identityId, payload.deviceId))


@router.post("/auth/identity/switch")
def switch_identity(
    payload: SwitchIdentityRequest, service: AuthService = Depends(get_auth_service)
) -> dict:
    return envelope(
        service.switch_identity(payload.refreshToken, payload.targetIdentityId, payload.deviceId)
    )


@router.post("/auth/token/refresh")
def refresh_token(payload: RefreshTokenRequest, service: AuthService = Depends(get_auth_service)) -> dict:
    return envelope(service.refresh(payload.refreshToken, payload.deviceId))


@router.post("/auth/logout")
def logout(
    payload: LogoutRequest | None = None, service: AuthService = Depends(get_auth_service)
) -> dict:
    service.logout(payload.refreshToken if payload else None)
    return envelope(None)


@router.get("/auth/identities")
def identities(
    principal=Depends(current_identity),
    service: AuthService = Depends(get_auth_service),
) -> dict:
    return envelope(service.list_identity_views(principal.account_id))


@router.post("/identities/personal")
def create_personal_identity(
    payload: CreatePersonalIdentityRequest,
    account_id: int = Depends(register_account_id),
    service: AuthService = Depends(get_auth_service),
) -> dict:
    return envelope(service.create_personal_identity(account_id, payload.nickname, payload.deviceId))
