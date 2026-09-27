"""账号设置：资料、密码、设备与通知偏好（spec §6.2）。"""

from __future__ import annotations

import bcrypt
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from ..models import Account, Identity
from ..store import AccountRevocationStore, RefreshTokenStore
from ..config import settings


class AccountService:
    def __init__(
        self,
        session: Session,
        refresh_tokens: RefreshTokenStore,
        revocations: AccountRevocationStore | None = None,
    ):
        self._session = session
        self._refresh_tokens = refresh_tokens
        # 可选：只做资料 / 密码相关的单元测试时可以只传 refresh store
        self._revocations = revocations

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

    # ----------------------------------------------------------------------------------
    # 自助注销（spec §3.1 / §5.3「注销」，商店规范 §2.7）
    # ----------------------------------------------------------------------------------
    DELETED_NICKNAME = "已注销用户"

    #: 本账号的全部个人日历
    _PERSONAL_CALENDARS = (
        "SELECT id FROM calendar WHERE calendar_type = 'PERSONAL'"
        " AND owner_identity_id IN (SELECT id FROM identity WHERE account_id = :account_id)"
    )

    def delete_account(self, account_id: int) -> None:
        """注销账号：清个人数据 → 解组织绑定 → 匿名化账号 → 吊销令牌。

        顺序与 Java 版一致（见 `AccountService.deleteAccount`）：先清外部数据再动账号本身，
        否则实现侧还要按 account_id 反查身份，而此时身份已被停用、手机号已被匿名化，容易漏清。

        注销**不可逆**：手机号被释放给「重新注册」，因此不保留任何找回路径。
        """
        account = self._session.get(Account, account_id)
        if account is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)

        params = {"account_id": account_id}

        # 1) 解除组织绑定：组织侧成员记录保留（spec §3.2 的解绑语义），可重新认领
        self._session.execute(
            text(
                "UPDATE org_member SET identity_id = NULL, updated_at = now()"
                " WHERE identity_id IN (SELECT id FROM identity WHERE account_id = :account_id)"
            ),
            params,
        )
        # 2) 提醒（target_type 是多态引用，没有外键兜底，只能显式删）
        self._session.execute(
            text("DELETE FROM reminder WHERE identity_id IN (SELECT id FROM identity WHERE account_id = :account_id)"),
            params,
        )
        # 3) 别人待办里关联了本账号的日程：先断开关联（对方的数据不能跟着消失，spec §4.1.6）
        self._session.execute(
            text(
                "UPDATE task SET event_id = NULL, updated_at = now()"
                f" WHERE event_id IN (SELECT id FROM event WHERE calendar_id IN ({self._PERSONAL_CALENDARS}))"
            ),
            params,
        )
        # 4) 个人日程（event_exception 由 ON DELETE CASCADE 带走）
        self._session.execute(
            text(f"DELETE FROM event WHERE calendar_id IN ({self._PERSONAL_CALENDARS})"), params
        )
        # 5) 待办：先断父子关系（task.parent_task_id 是自引用外键），再整批删除
        self._session.execute(
            text(
                "UPDATE task SET parent_task_id = NULL, updated_at = now()"
                " WHERE owner_identity_id IN (SELECT id FROM identity WHERE account_id = :account_id)"
            ),
            params,
        )
        self._session.execute(
            text("DELETE FROM task WHERE owner_identity_id IN (SELECT id FROM identity WHERE account_id = :account_id)"),
            params,
        )
        # 6) 个人日历
        self._session.execute(
            text(
                "DELETE FROM calendar WHERE calendar_type = 'PERSONAL'"
                " AND owner_identity_id IN (SELECT id FROM identity WHERE account_id = :account_id)"
            ),
            params,
        )
        # 7) 意见反馈（含正文与图片）
        self._session.execute(text("DELETE FROM feedback WHERE account_id = :account_id"), params)
        # 8) 登录日志刻意不删：按《网络安全法》第二十一条要留存不少于 6 个月，
        #    且账号行会被匿名化，日志里也不含手机号。

        # 身份：停用 + 抹掉昵称 / 头像 / 通知偏好。
        # 不物理删除——组织日程的 creator_identity_id 仍指向它，但行里已无可识别信息。
        for identity in self._session.execute(
            select(Identity).where(Identity.account_id == account_id)
        ).scalars():
            identity.status = "DISABLED"
            identity.nickname = self.DELETED_NICKNAME
            identity.avatar_url = None
            identity.notification_prefs = {}

        # 账号：手机号匿名化（原号因此可被重新注册），第三方绑定与密码一并清空
        account.phone = f"deleted-{account.id}"
        account.phone_verified_at = None
        account.password_hash = None
        account.wechat_unionid = None
        account.wechat_openid = None
        account.email = None
        account.email_verified_at = None
        account.status = "DISABLED"

        self._session.commit()

        # 最后吊销令牌：走完上面几步再下线，用户看到的是「注销成功」而不是「登录已失效」
        for record in self._refresh_tokens.list_for_account(account_id):
            self._refresh_tokens.delete(record.token_id)
        # 吊销刷新令牌只断掉「续期」：已经签发的 access token 还在有效期内，
        # 必须再打一个作废标记让它**当场**失效，否则注销后还能继续写数据。
        if self._revocations is not None:
            self._revocations.revoke(account_id, settings.access_token_ttl)


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
        "memberKey": None,
        "orgRole": None,
    }
