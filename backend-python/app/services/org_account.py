"""组织账号：认领（登录）、列表与解绑（spec §3.1 / §3.2 / §4.2.5）。行为与 Java 版 OrgAccountService 对齐。

这一组接口都用**个人身份**的令牌调用——它们作用于「当前个人账号绑定了哪些组织账号」，
而 /org/** 用**组织身份**的令牌调用。两套上下文在这里交界，别混。

为什么是「认领」而不是「密码登录」：组织侧导入成员时只写唯一识别 ID（学号/工号），不设密码。
取舍与加固方向见 spec §3.1 的安全说明——首版认领到的只是一个只读的组织日历视图，
但必须提供管理员解绑，否则被冒领的人没有恢复路径。
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from ..store import RefreshTokenStore
from .auth import AuthService
from .org import OrgService


class OrgAccountService:
    def __init__(self, session: Session, auth_service: AuthService, refresh_tokens: RefreshTokenStore):
        self._session = session
        self._auth = auth_service
        self._refresh_tokens = refresh_tokens

    def login(self, account_id: int, org: str, member_key: str, device_id: str) -> dict:
        """登录组织账号 = 认领并绑定；重复登录幂等。"""
        organization = self._require_active_org(org)
        key = (member_key or "").strip()
        if not key:
            raise ApiError(ErrorCode.PARAM_MISSING, "成员唯一识别 ID 不能为空")

        member = self._session.execute(
            text("SELECT * FROM org_member WHERE org_id = :org_id AND member_key = :key"),
            {"org_id": organization["id"], "key": key},
        ).mappings().first()
        if member is None:
            # 不区分「组织不对」与「成员不对」：否则这个接口就成了组织成员名单的探测工具
            raise ApiError(ErrorCode.FORBIDDEN, "组织唯一 ID 或成员唯一识别 ID 不正确")
        if member["status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "该成员已离职或停用，请联系组织管理员")

        identity_id = self._ensure_identity(account_id, organization["id"], member)
        self._session.execute(
            text("UPDATE org_member SET last_login_at = now() WHERE id = :id"),
            {"id": member["id"]},
        )
        self._session.commit()

        tokens = self._auth.select_identity(account_id, identity_id, device_id)
        return {
            "account": self._view(member, organization, identity_id),
            "accessToken": tokens["accessToken"],
            "refreshToken": tokens["refreshToken"],
            "expiresIn": tokens["expiresIn"],
        }

    def list(self, account_id: int) -> list[dict]:
        """我绑定过的组织账号。解绑后身份被停用，自然不在列表里。"""
        rows = self._session.execute(
            text(
                """
                SELECT i.id AS identity_id, i.nickname, m.*, o.name AS org_name, o.code AS org_code,
                       d.name AS department_name
                FROM identity i
                  JOIN org_member m ON m.identity_id = i.id
                  JOIN organization o ON o.id = i.org_id AND o.deleted_at IS NULL
                  LEFT JOIN department d ON d.id = m.department_id
                WHERE i.account_id = :account_id AND i.identity_type = 'ORG_MEMBER'
                  AND i.status = 'ACTIVE'
                  AND m.status <> 'LEFT'
                ORDER BY m.last_login_at DESC NULLS LAST, i.id DESC
                """
            ),
            {"account_id": account_id},
        ).mappings().all()
        return [
            {
                "identityId": row["identity_id"],
                "orgId": row["org_id"],
                "orgName": row["org_name"],
                "orgCode": row["org_code"],
                "memberKey": row["member_key"],
                "realName": row["real_name"] or row["nickname"],
                "departmentName": row["department_name"],
                "orgRole": row["org_role"],
                "lastLoginAt": row["last_login_at"],
            }
            for row in rows
        ]

    def unlink(self, account_id: int, identity_id: int) -> None:
        """解绑：停用组织身份 + 吊销会话 + 清掉认领关系；成员记录保留。"""
        identity = self._session.execute(
            text("SELECT * FROM identity WHERE id = :id"), {"id": identity_id}
        ).mappings().first()
        if (
            identity is None
            or identity["identity_type"] != "ORG_MEMBER"
            or identity["account_id"] != account_id
        ):
            raise ApiError(ErrorCode.FORBIDDEN, "该组织账号不属于当前账号")

        member = self._session.execute(
            text("SELECT * FROM org_member WHERE identity_id = :id"), {"id": identity_id}
        ).mappings().first()
        if member is not None:
            OrgService(self._session, self._refresh_tokens).unbind_member_row(dict(member))
        else:
            # 成员记录已经不在（例如被组织删除）：至少把身份停用、会话吊销掉
            self._session.execute(
                text("UPDATE identity SET status = 'DISABLED' WHERE id = :id"), {"id": identity_id}
            )
            self._refresh_tokens.revoke_all_for_identity(identity_id)
        self._session.commit()

    @staticmethod
    def require_personal(principal) -> None:
        """该接口只对个人身份开放：拿组织身份调它没有意义，只会让人误以为绑定了别的组织。"""
        if principal.identity_type == "ORG_MEMBER":
            raise ApiError(ErrorCode.FORBIDDEN, "该接口需用个人身份调用")

    def _require_active_org(self, org: str) -> dict:
        """解析组织唯一 ID：先按组织编码精确匹配，没有则按数字 ID 匹配。"""
        value = (org or "").strip()
        if not value:
            raise ApiError(ErrorCode.PARAM_MISSING, "组织唯一 ID 不能为空")
        found = self._session.execute(
            text(
                "SELECT * FROM organization WHERE code = :value AND deleted_at IS NULL LIMIT 1"
            ),
            {"value": value},
        ).mappings().first()
        if found is None and value.isdigit():
            found = self._session.execute(
                text("SELECT * FROM organization WHERE id = :id AND deleted_at IS NULL"),
                {"id": int(value)},
            ).mappings().first()
        if found is None:
            raise ApiError(ErrorCode.FORBIDDEN, "组织不存在")
        if found["status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "组织已停用")
        return dict(found)

    def _ensure_identity(self, account_id: int, org_id: int, member) -> int:
        identity_id = member["identity_id"]
        if identity_id is not None:
            bound = self._session.execute(
                text("SELECT * FROM identity WHERE id = :id"), {"id": identity_id}
            ).mappings().first()
            if bound is not None:
                if bound["account_id"] != account_id:
                    raise ApiError(
                        ErrorCode.FORBIDDEN, "该组织账号已被其他个人账号认领，请联系组织管理员解绑"
                    )
                if bound["status"] != "ACTIVE":
                    # 解绑过又重新认领：复用原身份，避免撞 (account_id, org_id) 唯一键
                    self._session.execute(
                        text("UPDATE identity SET status = 'ACTIVE' WHERE id = :id"),
                        {"id": identity_id},
                    )
                return identity_id

        existing = self._session.execute(
            text(
                "SELECT * FROM identity WHERE account_id = :account_id AND org_id = :org_id LIMIT 1"
            ),
            {"account_id": account_id, "org_id": org_id},
        ).mappings().first()
        if existing is None:
            created = self._session.execute(
                text(
                    "INSERT INTO identity (account_id, identity_type, org_id, nickname, status)"
                    " VALUES (:account_id, 'ORG_MEMBER', :org_id, :nickname, 'ACTIVE') RETURNING id"
                ),
                {
                    "account_id": account_id,
                    "org_id": org_id,
                    "nickname": member["real_name"],
                },
            ).scalar_one()
        else:
            created = existing["id"]
            if existing["status"] != "ACTIVE":
                self._session.execute(
                    text("UPDATE identity SET status = 'ACTIVE' WHERE id = :id"), {"id": created}
                )

        self._session.execute(
            text("UPDATE org_member SET identity_id = :identity WHERE id = :id"),
            {"identity": created, "id": member["id"]},
        )
        return created

    def _view(self, member, organization, identity_id: int) -> dict:
        department_name = None
        if member["department_id"] is not None:
            department_name = self._session.execute(
                text("SELECT name FROM department WHERE id = :id"), {"id": member["department_id"]}
            ).scalar_one_or_none()
        return {
            "identityId": identity_id,
            "orgId": organization["id"],
            "orgName": organization["name"],
            "orgCode": organization["code"],
            "memberKey": member["member_key"],
            "realName": member["real_name"],
            "departmentName": department_name,
            "orgRole": member["org_role"],
            "lastLoginAt": member["last_login_at"],
        }
