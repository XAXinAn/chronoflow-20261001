"""推送（spec §4.5）：设备注册表 + 极光通道 + 业务侧发通知的入口。

与 Java 版一一对应（`com.chronoflow.support.push.*` / `PushDeviceService` / `PushNotifier`）：
同样的表、同样的三条硬规则、同样的「按账号而不是按身份找设备」。

三条硬规则：
  1. **推送失败绝不抛出** —— 发不出去是常态（没装 App、被系统杀、没配通道），
     绝不能让「下发组织日程」这种业务操作跟着失败；
  2. 尊重 identity.notification_prefs 的类型开关；
  3. 通道说标识失效就停用，避免每次推送都重复失败。
"""

from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings

logger = logging.getLogger(__name__)

PROVIDER_JPUSH = "jpush"
TYPE_ORG_EVENT = "orgEvent"
TYPE_EVENT_REMINDER = "eventReminder"
TYPE_TASK_REMINDER = "taskReminder"

PLATFORMS = ("android", "ios")


@dataclass
class PushOutcome:
    requested: int
    invalid: list[str]
    failure_reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.failure_reason is None


def channel_configured() -> bool:
    return bool(settings.jpush_app_key and settings.jpush_master_secret)


def send_push(registration_ids: list[str], title: str, body: str, extras: dict) -> PushOutcome:
    """往极光发一条通知。返回结果而不是抛异常（见模块开头第 1 条规则）。"""
    targets = [r for r in registration_ids if r]
    if not targets:
        return PushOutcome(0, [])
    if not channel_configured():
        logger.debug("未配置极光推送通道，跳过 %d 台设备", len(targets))
        return PushOutcome(len(targets), [], "push channel not configured")

    payload = {
        "platform": "all",
        "audience": {"registration_id": targets},
        "notification": {
            "android": {"alert": body, "title": title, "extras": extras},
            "ios": {"alert": body, "sound": "default", "extras": extras},
        },
        "options": {
            "apns_production": settings.jpush_apns_production,
            "time_to_live": 86400,
        },
    }
    raw = f"{settings.jpush_app_key}:{settings.jpush_master_secret}".encode()
    request = urllib.request.Request(
        f"{settings.jpush_base_url}/v3/push",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Basic " + base64.b64encode(raw).decode(),
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            parsed = json.loads(response.read().decode("utf-8") or "{}")
        # 极光失败也可能返回 200 + {"error": {...}}，所以不能只看状态码
        if isinstance(parsed, dict) and parsed.get("error"):
            error = parsed["error"]
            invalid = targets if error.get("code") == 1011 else []
            return PushOutcome(len(targets), invalid, f"jpush error {error.get('code')}: {error.get('message')}")
        return PushOutcome(len(targets), [])
    except urllib.error.HTTPError as exc:
        return PushOutcome(len(targets), [], f"jpush http {exc.code}")
    except Exception as exc:  # noqa: BLE001 —— 网络类异常都要吞掉，推送不能拖垮业务
        logger.warning("极光推送请求失败：%s", exc)
        return PushOutcome(len(targets), [], f"{type(exc).__name__}: {exc}")


class PushDeviceService:
    """设备注册表：App 上报 registrationId，服务端按账号找设备。"""

    def __init__(self, session: Session):
        self._session = session

    def register(
        self, account_id: int, identity_id: int, registration_id: str,
        platform: str | None, app_version: str | None,
    ) -> dict:
        if not registration_id:
            raise ValueError("registrationId 不能为空")
        normalized = platform.lower() if platform else None
        if normalized is not None and normalized not in PLATFORMS:
            raise ValueError(f"platform 取值非法: {platform}")
        # 唯一键 (provider, registration_id)：换账号登录时改绑，而不是让两台设备共用一个标识
        row = self._session.execute(
            text(
                "INSERT INTO push_device (account_id, identity_id, provider, registration_id,"
                " platform, app_version) VALUES (:account_id, :identity_id, :provider,"
                " :registration_id, :platform, :app_version)"
                " ON CONFLICT (provider, registration_id) DO UPDATE SET"
                " account_id = EXCLUDED.account_id, identity_id = EXCLUDED.identity_id,"
                " platform = EXCLUDED.platform, app_version = EXCLUDED.app_version,"
                " disabled_at = NULL, updated_at = now()"
                " RETURNING id, registration_id, platform, app_version, created_at, updated_at"
            ),
            {
                "account_id": account_id,
                "identity_id": identity_id,
                "provider": PROVIDER_JPUSH,
                "registration_id": registration_id,
                "platform": normalized,
                "app_version": app_version,
            },
        ).mappings().one()
        self._session.commit()
        return dict(row)

    def unregister(self, account_id: int, registration_id: str) -> None:
        updated = self._session.execute(
            text(
                "UPDATE push_device SET disabled_at = now(), updated_at = now()"
                " WHERE account_id = :account_id AND registration_id = :registration_id"
                " AND disabled_at IS NULL"
            ),
            {"account_id": account_id, "registration_id": registration_id},
        ).rowcount
        self._session.commit()
        if not updated:
            raise ValueError("该设备不存在或不属于当前账号")

    def list_mine(self, account_id: int) -> list[dict]:
        rows = self._session.execute(
            text(
                "SELECT id, registration_id, platform, app_version, created_at, updated_at"
                " FROM push_device WHERE account_id = :account_id AND disabled_at IS NULL"
                " ORDER BY updated_at DESC"
            ),
            {"account_id": account_id},
        ).mappings()
        return [dict(row) for row in rows]

    def active_ids_for_accounts(self, account_ids: list[int]) -> list[str]:
        if not account_ids:
            return []
        rows = self._session.execute(
            text(
                "SELECT DISTINCT registration_id FROM push_device"
                " WHERE account_id = ANY(:account_ids) AND disabled_at IS NULL"
            ),
            {"account_ids": account_ids},
        ).scalars()
        return list(rows)

    def disable(self, registration_ids: list[str]) -> None:
        if not registration_ids:
            return
        self._session.execute(
            text(
                "UPDATE push_device SET disabled_at = now()"
                " WHERE registration_id = ANY(:ids) AND disabled_at IS NULL"
            ),
            {"ids": registration_ids},
        )
        self._session.commit()


def notify_identities(session: Session, identity_ids: list[int], kind: str,
                      title: str, body: str, extras: dict) -> int:
    """给一批**身份**发通知（内部换算到账号，与 Java 版同一套口径）。"""
    try:
        targets = [i for i in dict.fromkeys(identity_ids or []) if i is not None]
        if not targets:
            return 0
        allowed = [i for i in targets if not _notifications_disabled(session, i, kind)]
        if not allowed:
            return 0
        account_ids = list(
            session.execute(
                text("SELECT DISTINCT account_id FROM identity WHERE id = ANY(:ids)"),
                {"ids": allowed},
            ).scalars()
        )
        if not account_ids:
            return 0
        devices = PushDeviceService(session)
        registration_ids = devices.active_ids_for_accounts(account_ids)
        if not registration_ids:
            return 0
        outcome = send_push(registration_ids, title, body, extras)
        if not outcome.ok:
            logger.warning("推送未送达 kind=%s 设备数=%s 原因=%s", kind, outcome.requested, outcome.failure_reason)
        devices.disable(outcome.invalid)
        return outcome.requested
    except Exception:  # noqa: BLE001 —— 兜底：连查库都可能失败，但依然不能影响业务
        logger.warning("推送流程异常 kind=%s", kind, exc_info=True)
        return 0


def _notifications_disabled(session: Session, identity_id: int, kind: str) -> bool:
    prefs = session.execute(
        text("SELECT notification_prefs FROM identity WHERE id = :id"), {"id": identity_id}
    ).scalar()
    if not prefs:
        return False
    try:
        data = prefs if isinstance(prefs, dict) else json.loads(prefs)
        return kind in data and not bool(data[kind])
    except Exception:  # noqa: BLE001 —— 解析失败一律当作开启：推送比静默丢消息更容易被发现
        return False
