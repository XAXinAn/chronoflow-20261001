"""账号设置：资料、密码、设备与通知偏好（spec §6.2）。"""

from __future__ import annotations

import bcrypt
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from ..models import Account, Identity
from ..store import RefreshTokenStore


class AccountService:
    def __init__(self, session: Session, refresh_tokens: RefreshTokenStore):
        self._session = session
        self._refresh_tokens = refresh_tokens

    def update_profile(
        self, identity_id: int, nickname: str | None, avatar_url: str | None, timezone: str | None
    ) -> dict:
        identity = self._require_identity(identity_id)
        if nickname:
            identity.nickname = nickname
        if avatar_url is not None:
            identity.avatar_url = avatar_url
        if timezone:
            identity.timezone = timezone
        self._session.commit()
        return {
            "identityId": identity.id,
            "identityType": identity.identity_type,
            "nickname": identity.nickname,
            "avatarUrl": identity.avatar_url,
            "timezone": identity.timezone,
            "orgId": identity.org_id,
        }

    def set_password(self, account_id: int, old_password: str | None, new_password: str) -> None:
        account = self._session.get(Account, account_id)
        if account is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
        if account.password_hash:
            if not old_password:
                raise ApiError(ErrorCode.PARAM_INVALID, "请提供原密码")
            if not bcrypt.checkpw(old_password.encode(), account.password_hash.encode()):
                raise ApiError(ErrorCode.PASSWORD_MISMATCH)
        # 与 Java 版一致使用 BCrypt；两版产出的哈希互相可校验
        account.password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(rounds=10)).decode()
        self._session.commit()

    def devices(self, identity_id: int) -> list[dict]:
        return [
            {"deviceId": record.device_id, "issuedAt": record.issued_at}
            for record in self._refresh_tokens.list_for_identity(identity_id)
        ]

    def revoke_device(self, identity_id: int, device_id: str) -> None:
        if not self._refresh_tokens.revoke_device(identity_id, device_id):
            raise ApiError(ErrorCode.PARAM_INVALID, "该设备不存在或已下线")

    def update_notification_prefs(self, identity_id: int, prefs: dict[str, bool]) -> dict[str, bool]:
        identity = self._require_identity(identity_id)
        identity.notification_prefs = prefs
        self._session.commit()
        return prefs

    def _require_identity(self, identity_id: int) -> Identity:
        identity = self._session.get(Identity, identity_id)
        if identity is None:
            raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE)
        return identity


def identity_view(session: Session, account_id: int, identity_id: int) -> dict:
    rows = session.execute(
        select(Identity).where(Identity.id == identity_id, Identity.account_id == account_id)
    ).scalars()
    identity = rows.first()
    if identity is None:
        raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE)
    return {
        "identityId": identity.id,
        "identityType": identity.identity_type,
        "nickname": identity.nickname,
        "avatarUrl": identity.avatar_url,
        "timezone": identity.timezone,
        "orgId": identity.org_id,
        "orgName": None,
        "departmentName": None,
        "memberNo": None,
        "orgRole": None,
    }
