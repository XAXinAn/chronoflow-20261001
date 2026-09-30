"""把「当前账号 + 客户端传来的 orgIdentityId」解析成助手的可见范围。

与 Java 版 `AgentScopeResolver` 同一条规则：**越权校验就在这里**。请求体里的
`orgIdentityId` 是不能信的输入，必须确认它确实属于当前账号、且是一条可用的组织身份。
校验放在服务层而不是路由里，是为了将来任何入口都自动受同一套规则约束。

助手这次能「看到」的范围 = **个人日程 + 当前组织下发给我的日程**（后者只读）。
个人日程挂在**个人身份**的日历下，所以这里刻意不直接用令牌里的 identity_id：
用户可能正泡在组织视图里点开小安，用账号去找个人身份，两种入口都能查对。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode


@dataclass(frozen=True)
class AgentScope:
    account_id: int
    personal_identity_id: int
    org_identity_id: int | None = None
    org_id: int | None = None
    org_name: str | None = None
    org_member: dict | None = None

    @property
    def has_org(self) -> bool:
        return self.org_member is not None


def resolve(session: Session, account_id: int, org_identity_id: int | None) -> AgentScope:
    personal_identity_id = _personal_identity_id(session, account_id)
    if org_identity_id is None:
        return AgentScope(account_id=account_id, personal_identity_id=personal_identity_id)

    identity = session.execute(
        text("SELECT * FROM identity WHERE id = :id"), {"id": org_identity_id}
    ).mappings().first()
    if (
        identity is None
        or identity["account_id"] != account_id
        or identity["identity_type"] != "ORG_MEMBER"
        or identity["org_id"] is None
    ):
        # 注意措辞：不透露该身份是否存在，只说「不属于当前账号」
        raise ApiError(ErrorCode.FORBIDDEN, "该组织身份不属于当前账号")

    member = session.execute(
        text(
            "SELECT * FROM org_member WHERE org_id = :org_id AND identity_id = :identity_id"
        ),
        {"org_id": identity["org_id"], "identity_id": identity["id"]},
    ).mappings().first()
    if member is None or member["status"] != "ACTIVE":
        raise ApiError(ErrorCode.FORBIDDEN, "组织成员身份已停用或不存在")

    org = session.execute(
        text("SELECT * FROM organization WHERE id = :id"), {"id": identity["org_id"]}
    ).mappings().first()
    if org is None or org["status"] != "ACTIVE":
        raise ApiError(ErrorCode.FORBIDDEN, "组织已停用")

    return AgentScope(
        account_id=account_id,
        personal_identity_id=personal_identity_id,
        org_identity_id=org_identity_id,
        org_id=org["id"],
        org_name=org["name"],
        org_member=dict(member),
    )


def _personal_identity_id(session: Session, account_id: int) -> int:
    row = session.execute(
        text(
            "SELECT id FROM identity WHERE account_id = :account_id AND identity_type = 'PERSONAL'"
            " ORDER BY id LIMIT 1"
        ),
        {"account_id": account_id},
    ).first()
    if row is None:
        raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE, "当前账号没有可用的个人身份")
    return row[0]
