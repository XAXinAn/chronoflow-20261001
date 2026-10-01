"""账号与安全（spec §6.2）：实名认证 + 邮箱绑定。**与 Java 版语义一字对齐**。

* 实名：阿里云 CloudAuth（ID_PRO：姓名 + 身份证 + 活体）。两步：`InitFaceVerify`
  换认证页地址 → 客户端做人脸 → `DescribeFaceVerify` 回查，通过才落库。
* 邮箱：阿里云 DirectMail（`SingleSendMail`），发信地址与老项目同源。
* 两个通道都**不引官方 SDK**：RPC 签名用标准库实现（与 Java 版同一套算法）。
* 身份证号明文只在请求体里出现一次：立刻 AES-GCM 加密 + HMAC 指纹（指纹用于唯一约束）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from ..store import VerificationCodeStore

CODE_TTL = 600
SEND_LOCK_TTL = 60
FAILURE_TTL = 600
MAX_VERIFY_FAILURES = 5
PENDING_TTL = 1800
CALL_TIMEOUT = 8.0


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _percent(value: str) -> str:
    """RFC3986 编码：空格是 %20、~ 不编码（与阿里云要求一致）。"""
    return quote(value, safe="-_.~")


def _signed_query(params: dict[str, str], access_key_secret: str) -> str:
    canonical = "&".join(f"{_percent(k)}={_percent(params[k])}" for k in sorted(params))
    string_to_sign = f"GET&{_percent('/')}&{_percent(canonical)}"
    digest = hmac.new(
        (access_key_secret + "&").encode(), string_to_sign.encode(), hashlib.sha1
    ).digest()
    return f"{canonical}&Signature={_percent(base64.b64encode(digest).decode())}"


def _rpc(endpoint: str, params: dict[str, str], access_key_secret: str, object_field: str) -> dict:
    """调一次阿里云 RPC 接口（短信 / 邮件 / 实人认证都是同一套签名）。"""
    url = f"https://{endpoint}/?{_signed_query(params, access_key_secret)}"
    try:
        body = httpx.get(url, timeout=CALL_TIMEOUT).json()
    except Exception as exc:  # noqa: BLE001 —— 统一翻译成「第三方不可用」
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "第三方服务不可用，请稍后重试") from exc
    if str(body.get("Code")) != "200":
        message = body.get("Message") or body.get("Code") or ""
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, f"第三方服务调用失败：{message}")
    return body.get(object_field) or {}


class SecurityService:
    def __init__(self, session: Session, codes: VerificationCodeStore) -> None:
        self._session = session
        self._codes = codes

    # ------------------------------------------------------------- 状态
    def view(self, account_id: int) -> dict:
        row = self._account(account_id)
        return {
            "email": row["email"],
            "emailVerified": row["email_verified_at"] is not None,
            "realNameVerified": bool(row["real_name_verified"]),
            "realName": row["real_name"],
        }

    # ------------------------------------------------------------- 邮箱
    def send_email_code(self, email: str) -> dict:
        email = email.strip().lower()
        if not self._codes.acquire_send_lock(email, SEND_LOCK_TTL):
            raise ApiError(ErrorCode.SMS_SEND_TOO_FREQUENT, "验证码发送过于频繁，请稍后再试")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            self._send_mail(email, code)
        except ApiError:
            # 没发出去就不该把用户锁在 60 秒里（与短信一致）
            self._codes.delete_code(email)
            raise
        self._codes.save_code(email, code, CODE_TTL)
        expose = _env("EXPOSE_MAIL_CODE", "false").lower() == "true"
        return {"expiresIn": CODE_TTL, "debugCode": code if expose else None}

    def verify_email_code(self, email: str, code: str) -> None:
        expected = self._codes.find_code(email)
        if expected is None:
            raise ApiError(ErrorCode.SMS_CODE_INVALID, "验证码已过期，请重新获取")
        if expected != code:
            if self._codes.increment_verify_failure(email, FAILURE_TTL) >= MAX_VERIFY_FAILURES:
                self._codes.delete_code(email)
                self._codes.clear_verify_failure(email)
            raise ApiError(ErrorCode.SMS_CODE_INVALID, "验证码不正确")
        self._codes.delete_code(email)
        self._codes.clear_verify_failure(email)

    def bind_email(self, account_id: int, email: str) -> dict:
        email = email.strip().lower()
        taken = self._session.execute(
            text("SELECT 1 FROM account WHERE email = :email AND id <> :id"),
            {"email": email, "id": account_id},
        ).first()
        if taken:
            raise ApiError(ErrorCode.PARAM_INVALID, "该邮箱已被其他账号绑定")
        self._session.execute(
            text(
                "UPDATE account SET email = :email, email_verified_at = now(),"
                " updated_at = now() WHERE id = :id"
            ),
            {"email": email, "id": account_id},
        )
        self._session.commit()
        return self.view(account_id)

    def _send_mail(self, email: str, code: str) -> None:
        if _env("MAIL_PROVIDER", "log") != "aliyun":
            if _env("EXPOSE_MAIL_CODE", "false").lower() != "true":
                raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "邮件通道未配置")
            print(f"[mail] 开发通道（不真发）email={email} code={code}")  # noqa: T201
            return
        params = {
            "AccessKeyId": _env("ALIYUN_DM_ACCESS_KEY_ID"),
            "AccountName": _env("ALIYUN_DM_ACCOUNT_NAME"),
            "Action": "SingleSendMail",
            "AddressType": "1",
            "Format": "JSON",
            "FromAlias": _env("ALIYUN_DM_FROM_ALIAS", "时纪流"),
            "HtmlBody": (
                "<div style='font-family:sans-serif'>你的验证码是 "
                f"<b style='font-size:20px'>{code}</b>，10 分钟内有效。</div>"
            ),
            "ReplyToAddress": "false",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": uuid.uuid4().hex,
            "SignatureVersion": "1.0",
            "Subject": "时纪流 · 邮箱验证码",
            "Timestamp": _timestamp(),
            "ToAddress": email,
            "Version": "2015-11-23",
        }
        _rpc(
            _env("ALIYUN_DM_ENDPOINT", "dm.aliyuncs.com"),
            params,
            _env("ALIYUN_DM_ACCESS_KEY_SECRET"),
            "ResultObject",
        )

    # ------------------------------------------------------------- 实名
    def init_realname(self, account_id: int, real_name: str, id_card_number: str) -> dict:
        self._require_realname_configured()
        normalized = id_card_number.strip().upper()
        params = self._cloudauth_params("InitFaceVerify")
        params.update(
            {
                "CertName": real_name.strip(),
                "CertNo": normalized,
                "CertType": "IDENTITY_CARD",
                "Model": "LIVENESS",
                "ProductCode": "ID_PRO",
                "OuterOrderNo": f"u{account_id}-{uuid.uuid4().hex}",
                "SceneId": _env("ALIYUN_CLOUDAUTH_SCENE_ID"),
                "UserId": str(account_id),
                "MetaInfo": '{"zimVer":"3.0.0","appVersion":"1.0"}',
            }
        )
        result = _rpc(
            _env("ALIYUN_CLOUDAUTH_ENDPOINT", "cloudauth.cn-shanghai.aliyuncs.com"),
            params,
            _env("ALIYUN_CLOUDAUTH_ACCESS_KEY_SECRET"),
            "ResultObject",
        )
        certify_id = result.get("CertifyId") or ""
        certify_url = result.get("CertifyUrl") or ""
        if not certify_id or not certify_url:
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "实名认证服务没有返回认证地址")
        # 认证未完成：姓名 / 密文 / 指纹暂存 Redis，30 分钟没做完就作废
        self._codes.save_code(
            f"realname:{certify_id}",
            "\n".join([real_name.strip(), self._encrypt(normalized), self._fingerprint(normalized)]),
            PENDING_TTL,
        )
        return {"certifyId": certify_id, "certifyUrl": certify_url}

    def realname_result(self, account_id: int, certify_id: str) -> dict:
        self._require_realname_configured()
        pending = self._codes.find_code(f"realname:{certify_id}")
        if pending is None:
            return {"verified": False, "message": "认证已超时，请重新发起"}
        params = self._cloudauth_params("DescribeFaceVerify")
        params["CertifyId"] = certify_id
        params["SceneId"] = _env("ALIYUN_CLOUDAUTH_SCENE_ID")
        result = _rpc(
            _env("ALIYUN_CLOUDAUTH_ENDPOINT", "cloudauth.cn-shanghai.aliyuncs.com"),
            params,
            _env("ALIYUN_CLOUDAUTH_ACCESS_KEY_SECRET"),
            "ResultObject",
        )
        if str(result.get("Passed", "")).upper() != "T":
            return {"verified": False, "message": result.get("SubCode") or "认证未通过"}
        name, cipher, fingerprint = pending.split("\n")
        taken = self._session.execute(
            text("SELECT 1 FROM account WHERE id_card_fingerprint = :fp AND id <> :id"),
            {"fp": fingerprint, "id": account_id},
        ).first()
        if taken:
            raise ApiError(ErrorCode.PARAM_INVALID, "该实名信息已被其他账号绑定")
        self._session.execute(
            text(
                "UPDATE account SET real_name = :name, id_card_cipher = :cipher,"
                " id_card_fingerprint = :fp, real_name_verified = true,"
                " real_name_verified_at = now(), updated_at = now() WHERE id = :id"
            ),
            {"name": name, "cipher": cipher, "fp": fingerprint, "id": account_id},
        )
        self._session.commit()
        self._codes.delete_code(f"realname:{certify_id}")
        return {"verified": True, "message": None}

    def _cloudauth_params(self, action: str) -> dict[str, str]:
        return {
            "AccessKeyId": _env("ALIYUN_CLOUDAUTH_ACCESS_KEY_ID"),
            "Action": action,
            "Format": "JSON",
            "RegionId": "cn-shanghai",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": uuid.uuid4().hex,
            "SignatureVersion": "1.0",
            "Timestamp": _timestamp(),
            "Version": "2019-03-07",
        }

    def _require_realname_configured(self) -> None:
        needed = (
            "ALIYUN_CLOUDAUTH_ACCESS_KEY_ID",
            "ALIYUN_CLOUDAUTH_ACCESS_KEY_SECRET",
            "ALIYUN_CLOUDAUTH_SCENE_ID",
            "CHRONOFLOW_IDENTITY_SECRET",
        )
        if any(not _env(name) for name in needed):
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "实名认证暂不可用（服务端未配置 CloudAuth）")

    def _derive(self, purpose: str) -> bytes:
        secret = _env("CHRONOFLOW_IDENTITY_SECRET")
        return hashlib.sha256(f"{purpose}:{secret}".encode()).digest()

    def _encrypt(self, plain: str) -> str:
        iv = secrets.token_bytes(12)
        encrypted = AESGCM(self._derive("aes")).encrypt(iv, plain.encode(), None)
        return base64.b64encode(iv + encrypted).decode()

    def _fingerprint(self, id_card_number: str) -> str:
        return hmac.new(
            self._derive("fingerprint"), id_card_number.encode(), hashlib.sha256
        ).hexdigest()

    def _account(self, account_id: int) -> Any:
        row = self._session.execute(
            text(
                "SELECT email, email_verified_at, real_name, real_name_verified"
                " FROM account WHERE id = :id"
            ),
            {"id": account_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE, "账号不存在")
        return row
