"""认证编排。行为与 Java 版 AuthService 逐条对齐（spec §3）。"""

from __future__ import annotations

import json
import random
import time
from datetime import datetime, timezone

import bcrypt
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..config import settings
from ..errors import ApiError, ErrorCode
from ..models import Account, Identity
from ..security import (
    IdentityPrincipal,
    TokenScope,
    issue_access_token,
    issue_scoped_token,
    new_token_id,
    parse_scoped_token,
)
from ..store import RefreshTokenRecord, RefreshTokenStore, VerificationCodeStore, now_seconds

DAILY_WINDOW = 24 * 60 * 60


class AuthService:
    def __init__(
        self,
        session: Session,
        codes: VerificationCodeStore,
        refresh_tokens: RefreshTokenStore,
    ):
        self._session = session
        self._codes = codes
        self._refresh_tokens = refresh_tokens

    # ------------------------------------------------------------ 验证码
    def send_sms_code(self, phone: str, client_ip: str | None) -> dict:
        if len(phone) != 11 or not phone.startswith("1") or not phone[1:].isdigit():
            raise ApiError(ErrorCode.PARAM_INVALID, "手机号格式不正确")

        if self._codes.increment_daily("phone", phone, DAILY_WINDOW) > settings.sms_daily_limit_per_phone:
            raise ApiError(ErrorCode.SMS_SEND_TOO_FREQUENT, "该手机号今日验证码发送次数已达上限")
        if client_ip:
            if (
                self._codes.increment_daily("ip", client_ip, DAILY_WINDOW)
                > settings.sms_daily_limit_per_ip
            ):
                raise ApiError(ErrorCode.SMS_SEND_TOO_FREQUENT, "当前网络今日验证码发送次数已达上限")
        if not self._codes.acquire_send_lock(phone, settings.sms_send_interval):
            raise ApiError(ErrorCode.SMS_SEND_TOO_FREQUENT)

        code = f"{random.randint(0, 999999):06d}"
        self._codes.save_code(phone, code, settings.sms_code_ttl)
        self._codes.clear_verify_failure(phone)
        # 开发环境回显验证码；生产环境该字段为 None（无短信通道时无法登录）
        return {
            "expiresIn": settings.sms_code_ttl,
            "debugCode": code if settings.expose_sms_code else None,
        }

    def _verify_code(self, phone: str, code: str) -> None:
        expected = self._codes.find_code(phone)
        if expected is None:
            raise ApiError(ErrorCode.SMS_CODE_INVALID)
        if expected != code:
            failures = self._codes.increment_verify_failure(phone, settings.sms_code_ttl)
            if failures >= settings.sms_max_verify_attempts:
                self._codes.delete_code(phone)
                self._codes.clear_verify_failure(phone)
            raise ApiError(ErrorCode.SMS_CODE_INVALID)
        self._codes.delete_code(phone)
        self._codes.clear_verify_failure(phone)

    # -------------------------------------------------------------- 登录
    def login_by_sms(self, phone: str, code: str) -> dict:
        self._verify_code(phone, code)
        account = self._session.scalar(select(Account).where(Account.phone == phone))
        if account is None:
            account = Account(phone=phone, status="ACTIVE")
            self._session.add(account)
            self._session.flush()
            self._session.execute(
                text("UPDATE account SET phone_verified_at = now(), last_login_at = now() WHERE id = :id"),
                {"id": account.id},
            )
        else:
            if account.status == "DISABLED":
                raise ApiError(ErrorCode.ACCOUNT_DISABLED)
            self._session.execute(
                text("UPDATE account SET last_login_at = now() WHERE id = :id"), {"id": account.id}
            )
        self._session.commit()
        return self._issue_login_challenge(account.id)

    def login_by_password(self, phone: str, password: str) -> dict:
        account = self._session.scalar(select(Account).where(Account.phone == phone))
        if account is None or not account.password_hash:
            raise ApiError(ErrorCode.PASSWORD_NOT_SET)
        if account.status == "DISABLED":
            raise ApiError(ErrorCode.ACCOUNT_DISABLED)
        if not bcrypt.checkpw(password.encode(), account.password_hash.encode()):
            raise ApiError(ErrorCode.PASSWORD_MISMATCH, "手机号或密码不正确")
        return self._issue_login_challenge(account.id)

    def _issue_login_challenge(self, account_id: int) -> dict:
        identities = self.list_identity_views(account_id)
        if not identities:
            token = issue_scoped_token(account_id, TokenScope.REGISTER, settings.register_token_ttl)
            return {
                "needRegister": True,
                "registerToken": token,
                "needSelectIdentity": False,
                "selectToken": None,
                "identities": [],
            }
        token = issue_scoped_token(account_id, TokenScope.IDENTITY_SELECT, settings.select_token_ttl)
        return {
            "needRegister": False,
            "registerToken": None,
            "needSelectIdentity": True,
            "selectToken": token,
            "identities": identities,
        }

    # -------------------------------------------------------------- 身份
    def list_identity_views(self, account_id: int) -> list[dict]:
        rows = self._session.execute(
            text(
                """
                SELECT i.id AS identity_id, i.identity_type, i.nickname, i.avatar_url, i.timezone,
                       o.id AS org_id, o.name AS org_name, o.logo_url AS org_logo_url,
                       d.name AS department_name, m.member_no, m.org_role
                FROM identity i
                  LEFT JOIN organization o ON o.id = i.org_id AND o.deleted_at IS NULL
                  LEFT JOIN org_member m
                    ON m.identity_id = i.id AND m.org_id = i.org_id AND m.status <> 'LEFT'
                  LEFT JOIN department d ON d.id = m.department_id
                WHERE i.account_id = :account_id AND i.status = 'ACTIVE'
                ORDER BY i.identity_type, o.id
                """
            ),
            {"account_id": account_id},
        ).mappings()
        return [dict(row) for row in rows]

    def create_personal_identity(self, account_id: int, nickname: str | None, device_id: str | None) -> dict:
        account = self._session.get(Account, account_id)
        if account is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)

        existing = self._session.scalar(
            select(Identity).where(
                Identity.account_id == account_id, Identity.identity_type == "PERSONAL"
            )
        )
        if existing is not None:
            raise ApiError(ErrorCode.MEMBER_ALREADY_EXISTS, "该账号已存在个人身份")

        identity = Identity(
            account_id=account_id,
            identity_type="PERSONAL",
            nickname=nickname or f"用户{account.phone[-4:]}",
            status="ACTIVE",
        )
        self._session.add(identity)
        self._session.commit()
        return self._issue_tokens(account_id, identity.id, "PERSONAL", None, device_id)

    def select_identity(self, account_id: int, identity_id: int, device_id: str | None) -> dict:
        identity = self._require_owned(account_id, identity_id)
        return self._issue_tokens(account_id, identity.id, identity.identity_type, identity.org_id, device_id)

    def switch_identity(self, refresh_token: str, target_identity_id: int, device_id: str | None) -> dict:
        record = self._require_refresh_token(refresh_token)
        self._require_active_account(record.account_id)
        identity = self._require_owned(record.account_id, target_identity_id)
        new_token = self._issue_refresh_token(record.account_id, identity.id, device_id)
        self._rotate(refresh_token, new_token)
        return self._build_token_response(
            record.account_id, identity.id, identity.identity_type, identity.org_id, new_token
        )

    # -------------------------------------------------------------- 令牌
    def refresh(self, refresh_token: str, device_id: str | None) -> dict:
        record = self._refresh_tokens.find(refresh_token)
        if record is None:
            # 并发刷新兜底：旧令牌在宽限期内已被轮换，取回同一个新令牌
            successor_id = self._refresh_tokens.find_successor(refresh_token)
            successor = self._refresh_tokens.find(successor_id) if successor_id else None
            if successor is None:
                raise ApiError(ErrorCode.REFRESH_TOKEN_INVALID)
            self._require_active_account(successor.account_id)
            identity = self._require_active_identity(successor.identity_id)
            return self._build_token_response(
                successor.account_id, identity.id, identity.identity_type, identity.org_id, successor.token_id
            )

        self._require_active_account(record.account_id)
        identity = self._require_active_identity(record.identity_id)
        new_token = self._issue_refresh_token(record.account_id, identity.id, device_id)
        self._rotate(refresh_token, new_token)
        return self._build_token_response(
            record.account_id, identity.id, identity.identity_type, identity.org_id, new_token
        )

    def logout(self, refresh_token: str | None) -> None:
        if refresh_token:
            self._refresh_tokens.delete(refresh_token)

    def _rotate(self, previous_token: str, new_token: str) -> None:
        self._refresh_tokens.save_successor(previous_token, new_token, settings.refresh_rotation_grace)
        self._refresh_tokens.delete(previous_token)

    def _issue_refresh_token(self, account_id: int, identity_id: int, device_id: str | None) -> str:
        token_id = new_token_id()
        self._refresh_tokens.save(
            RefreshTokenRecord(token_id, account_id, identity_id, device_id, now_seconds()),
            settings.refresh_token_ttl,
        )
        self._refresh_tokens.enforce_device_limit(identity_id, settings.max_devices_per_identity)
        return token_id

    def _require_refresh_token(self, token: str) -> RefreshTokenRecord:
        if not token:
            raise ApiError(ErrorCode.REFRESH_TOKEN_INVALID)
        record = self._refresh_tokens.find(token)
        if record is None:
            raise ApiError(ErrorCode.REFRESH_TOKEN_INVALID)
        return record

    def _issue_tokens(
        self,
        account_id: int,
        identity_id: int,
        identity_type: str,
        org_id: int | None,
        device_id: str | None,
    ) -> dict:
        refresh_token = self._issue_refresh_token(account_id, identity_id, device_id)
        return self._build_token_response(account_id, identity_id, identity_type, org_id, refresh_token)

    def _build_token_response(
        self, account_id: int, identity_id: int, identity_type: str, org_id: int | None, refresh_token: str
    ) -> dict:
        access_token = issue_access_token(
            IdentityPrincipal(account_id, identity_id, identity_type, org_id)
        )
        identity = self._session.get(Identity, identity_id)
        return {
            "accessToken": access_token,
            "refreshToken": refresh_token,
            "expiresIn": settings.access_token_ttl,
            "identity": {
                "accountId": account_id,
                "identityId": identity_id,
                "identityType": identity_type,
                "orgId": org_id,
                "nickname": identity.nickname if identity else None,
                "avatarUrl": identity.avatar_url if identity else None,
            },
        }

    # -------------------------------------------------------------- 校验
    def _require_owned(self, account_id: int, identity_id: int) -> Identity:
        identity = self._require_active_identity(identity_id)
        if identity.account_id != account_id:
            raise ApiError(ErrorCode.IDENTITY_NOT_OWNED)
        return identity

    def _require_active_identity(self, identity_id: int) -> Identity:
        identity = self._session.get(Identity, identity_id)
        if identity is None or identity.status != "ACTIVE":
            raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE)
        return identity

    def _require_active_account(self, account_id: int) -> Account:
        account = self._session.get(Account, account_id)
        if account is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
        if account.status == "DISABLED":
            # 账号被停用时吊销其全部刷新令牌，下一次刷新即要求重新登录
            for record in self._active_tokens_of(account_id):
                self._refresh_tokens.delete(record.token_id)
            raise ApiError(ErrorCode.ACCOUNT_DISABLED)
        return account

    def _active_tokens_of(self, account_id: int) -> list[RefreshTokenRecord]:
        return self._refresh_tokens.list_for_account(account_id)
