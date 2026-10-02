from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_session
from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.accounts import AccountService, identity_view
from ..services.security import SecurityService
from ..wiring import get_account_service, get_auth_service
from ..wiring import get_code_store

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


class SendEmailCodeRequest(BaseModel):
    email: str = Field(min_length=3, max_length=128)


class BindEmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=128)
    code: str = Field(min_length=6, max_length=6)


class SendPhoneCodeRequest(BaseModel):
    phone: str = Field(min_length=11, max_length=11)


class ChangePhoneRequest(BaseModel):
    newPhone: str = Field(min_length=11, max_length=11)
    newCode: str = Field(min_length=6, max_length=6)
    oldCode: str = Field(min_length=6, max_length=6)


class RealNameRequest(BaseModel):
    realName: str = Field(min_length=2, max_length=32)
    idCardNumber: str = Field(min_length=18, max_length=18)
    # 客户端 Web SDK（jsvm_all.js 的 window.getMetaInfo()）实时采集，禁止硬编码
    metaInfo: str = Field(min_length=2, max_length=8192)


def _security(
    session: Session = Depends(get_session),
    codes=Depends(get_code_store),
) -> SecurityService:
    """账号与安全的服务装配（与 Java 版同一个服务对象负责两件事）。"""
    return SecurityService(session, codes)


@router.get("/security")
def account_security(
    principal: IdentityPrincipal = Depends(current_identity),
    service: SecurityService = Depends(_security),
) -> dict:
    """实名与邮箱的当前状态（spec §6.2）。"""
    return envelope(service.view(principal.account_id))


@router.post("/email/code")
def send_email_code(
    payload: SendEmailCodeRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service: SecurityService = Depends(_security),
) -> dict:
    """给要绑定的邮箱发验证码（阿里云 DirectMail）。"""
    return envelope(service.send_email_code(payload.email))


@router.post("/email")
def bind_email(
    payload: BindEmailRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service: SecurityService = Depends(_security),
) -> dict:
    """绑定 / 改绑邮箱：验证码校验通过才写库。"""
    email = payload.email.strip().lower()
    service.verify_email_code(email, payload.code)
    return envelope(service.bind_email(principal.account_id, email))


@router.post("/phone/code")
def send_phone_code(
    payload: SendPhoneCodeRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(get_auth_service),
) -> dict:
    """换绑手机号第一步：给指定号码发验证码（旧号与新号都允许，频控与登录发码同一套）。"""
    return envelope(service.send_sms_code(payload.phone.strip(), None))


@router.post("/phone")
def change_phone(
    payload: ChangePhoneRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
    codes=Depends(get_code_store),
    security: SecurityService = Depends(_security),
) -> dict:
    """换绑手机号第二步：**旧号与新号的验证码都校验**，通过才改。

    只验新号的话，任何拿到 access token 的人都能把手机号换成自己的，等于把账号偷走。
    """
    current = security.view(principal.account_id)["phone"]

    def verify(phone: str, code: str) -> None:
        expected = codes.find_code(phone)
        if expected is None or expected != code:
            raise ApiError(ErrorCode.SMS_CODE_INVALID, "验证码不正确或已过期")
        codes.delete_code(phone)

    verify(current, payload.oldCode)
    verify(payload.newPhone.strip(), payload.newCode)
    return envelope(security.change_phone(principal.account_id, payload.newPhone))


@router.post("/realname")
def init_realname(
    payload: RealNameRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service: SecurityService = Depends(_security),
) -> dict:
    """发起实名认证：返回 CloudAuth 认证页地址（App 用 WebView 打开）。"""
    return envelope(
        service.init_realname(principal.account_id, payload.realName, payload.idCardNumber, payload.metaInfo)
    )


@router.get("/realname/result")
def realname_result(
    certifyId: str,
    principal: IdentityPrincipal = Depends(current_identity),
    service: SecurityService = Depends(_security),
) -> dict:
    """人脸做完后回查结果；通过才把实名写进账号。"""
    return envelope(service.realname_result(principal.account_id, certifyId))


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


@router.post("/deletion")
def delete_account(
    principal: IdentityPrincipal = Depends(current_identity),
    service: AccountService = Depends(get_account_service),
) -> dict:
    """自助注销账号（商店规范 §2.7：App 内必须有对应的注销功能按钮）。

    注销后本设备与其他设备的令牌同时失效，App 侧调完这个接口必须清掉本地会话。
    用 POST 而不是 DELETE：它不是「删掉一个资源」，而是一次不可逆的账号处置动作，
    与 /admin/accounts/{id}/status 保持同一风格。
    """
    service.delete_account(principal.account_id)
    return envelope(None)


_CAMEL_KEYS = {
    "identity_id": "identityId",
    "identity_type": "identityType",
    "avatar_url": "avatarUrl",
    "org_id": "orgId",
    "org_name": "orgName",
    "department_name": "departmentName",
    "member_key": "memberKey",
    "org_role": "orgRole",
}


def _camel(view: dict) -> dict:
    return {_CAMEL_KEYS.get(key, key): value for key, value in view.items()}
