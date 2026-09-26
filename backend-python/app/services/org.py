"""组织、部门、成员与组织日历下发回执（spec §4.2）。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from ..security import AdminPrincipal
from . import recurrence

MAX_DEPARTMENT_LEVEL = 5


class OrgService:
    def __init__(self, session: Session, refresh_tokens=None):
        self._session = session
        # 解绑组织账号要吊销该身份的会话；没注入时只做身份停用（旧调用点不必全改）
        self._refresh_tokens = refresh_tokens

    # ------------------------------------------------------------ 权限
    def require_membership(self, principal) -> dict:
        if principal.org_id is None:
            raise ApiError(ErrorCode.FORBIDDEN, "该接口需要组织身份")
        org = self._session.execute(
            text("SELECT * FROM organization WHERE id = :id AND deleted_at IS NULL"),
            {"id": principal.org_id},
        ).mappings().first()
        # 组织被平台停用后，成员不得再访问组织接口（spec §10.1 场景 10）
        if org is None or org["status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "组织已停用")
        member = self._session.execute(
            text(
                "SELECT * FROM org_member WHERE org_id = :org_id AND identity_id = :identity_id"
            ),
            {"org_id": principal.org_id, "identity_id": principal.identity_id},
        ).mappings().first()
        if member is None:
            raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE, "组织成员关系不存在")
        if member["status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "组织成员身份已停用")
        return {**dict(member), "org_name": org["name"], "org_code": org["code"],
                "org_timezone": org["timezone"], "org_logo_url": org["logo_url"]}

    @staticmethod
    def is_org_admin(member: dict) -> bool:
        return member["org_role"] in ("OWNER", "ADMIN")

    # ------------------------------------------------------- 执行者（成员 / 后台管理员）
    def resolve_actor(self, principal) -> dict:
        """把当前令牌解析成组织执行者（spec §3.2 / §4.3）。

        后台管理员在组织里没有 org_member 记录，因此 ``id`` / ``identity_id`` 为 None、
        部门范围是整个组织；其余字段与成员口径保持一致，业务方法不必分叉。
        """
        if isinstance(principal, AdminPrincipal):
            return self._admin_actor(principal)
        return self.require_membership(principal)

    def _admin_actor(self, admin: AdminPrincipal) -> dict:
        if admin.org_id is None or admin.role != "ORG_ADMIN":
            raise ApiError(ErrorCode.FORBIDDEN, "该接口需要组织管理员身份")
        org = self._session.execute(
            text("SELECT * FROM organization WHERE id = :id AND deleted_at IS NULL"),
            {"id": admin.org_id},
        ).mappings().first()
        if org is None or org["status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "组织已停用")
        return {
            "org_id": org["id"],
            "id": None,
            "identity_id": None,
            "admin_id": admin.admin_id,
            "org_role": "ADMIN",
            "department_id": None,
            "member_key": None,
            "real_name": admin.username,
            "job_title": None,
            "status": "ACTIVE",
            "org_name": org["name"],
            "org_code": org["code"],
            "org_timezone": org["timezone"],
            "org_logo_url": org["logo_url"],
        }

    def record_org_audit(
        self,
        actor: dict,
        action: str,
        target_type: str,
        target_id: int | None,
        detail=None,
    ) -> None:
        """组织管理操作写审计日志（spec §4.3「操作日志」）。失败不阻断主流程。"""
        try:
            if actor.get("admin_id") is not None:
                actor_type, actor_id, actor_name = "ADMIN", actor["admin_id"], actor["real_name"]
            else:
                actor_type, actor_id, actor_name = "ACCOUNT", actor["identity_id"], actor["real_name"]
            self._session.execute(
                text(
                    "INSERT INTO audit_log (actor_type, actor_id, actor_name, org_id, action,"
                    " target_type, target_id, detail) VALUES (:actor_type, :actor_id, :actor_name,"
                    " :org_id, :action, :target_type, :target_id, :detail)"
                ),
                {
                    "actor_type": actor_type,
                    "actor_id": actor_id,
                    "actor_name": actor_name,
                    "org_id": actor["org_id"],
                    "action": action,
                    "target_type": target_type,
                    "target_id": target_id,
                    "detail": json_dumps(detail) if detail else None,
                },
            )
            self._session.commit()
        except Exception:  # noqa: BLE001 - 审计写入失败不影响主流程
            self._session.rollback()

    @staticmethod
    def require_org_admin(member: dict) -> None:
        if member["org_role"] not in ("OWNER", "ADMIN"):
            raise ApiError(ErrorCode.FORBIDDEN, "该操作需要组织管理员权限")

    def all_departments(self, org_id: int) -> list[dict]:
        rows = self._session.execute(
            text(
                "SELECT * FROM department WHERE org_id = :org_id AND status = 'ACTIVE'"
                " ORDER BY level, sort_order, id"
            ),
            {"org_id": org_id},
        ).mappings()
        return [dict(row) for row in rows]

    def self_and_descendants(self, department: dict) -> list[dict]:
        # 物化路径结尾带斜杠，因此 '/5/' 不会误匹配 '/51/' —— 这是刻意设计
        rows = self._session.execute(
            text(
                "SELECT * FROM department WHERE org_id = :org_id AND status = 'ACTIVE'"
                " AND path LIKE :prefix"
            ),
            {"org_id": department["org_id"], "prefix": department["path"] + "%"},
        ).mappings()
        return [dict(row) for row in rows]

    def manageable_department_ids(self, member: dict) -> set[int]:
        if self.is_org_admin(member):
            return {department["id"] for department in self.all_departments(member["org_id"])}
        grants = self._session.execute(
            text("SELECT department_id FROM department_manager WHERE org_member_id = :member_id"),
            {"member_id": member["id"]},
        ).scalars().all()
        result: set[int] = set()
        for department_id in grants:
            department = self.require_department(member["org_id"], department_id)
            result.update(node["id"] for node in self.self_and_descendants(department))
        return result

    def require_can_manage_department(self, member: dict, department_id: int) -> dict:
        department = self.require_department(member["org_id"], department_id)
        if department["id"] not in self.manageable_department_ids(member):
            raise ApiError(ErrorCode.FORBIDDEN, "无权管理该部门")
        return department

    def require_department(self, org_id: int, department_id: int) -> dict:
        row = self._session.execute(
            text("SELECT * FROM department WHERE id = :id AND org_id = :org_id"),
            {"id": department_id, "org_id": org_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "部门不存在或不属于当前组织")
        return dict(row)

    # ------------------------------------------------------------ 部门
    def department_tree(self, org_id: int) -> list[dict]:
        children: dict[int | None, list[dict]] = {}
        for department in self.all_departments(org_id):
            children.setdefault(department["parent_id"], []).append(department)
        return _build_nodes(None, children)

    def create_department(self, member: dict, payload: dict) -> dict:
        parent_id = payload.get("parentId")
        parent = None
        if parent_id is not None:
            parent = self.require_department(member["org_id"], parent_id)
            self.require_can_manage_department(member, parent["id"])
            if parent["level"] >= MAX_DEPARTMENT_LEVEL:
                raise ApiError(ErrorCode.DEPARTMENT_LEVEL_EXCEEDED, f"部门层级最多 {MAX_DEPARTMENT_LEVEL} 层")
        else:
            self.require_org_admin(member)
        row = self._session.execute(
            text(
                "INSERT INTO department (org_id, parent_id, name, path, level, sort_order, status)"
                " VALUES (:org_id, :parent_id, :name, '/', :level, :sort_order, 'ACTIVE')"
                " RETURNING *"
            ),
            {
                "org_id": member["org_id"],
                "parent_id": parent_id,
                "name": payload["name"],
                "level": 1 if parent is None else parent["level"] + 1,
                "sort_order": payload.get("sortOrder") or 0,
            },
        ).mappings().one()
        parent_path = "/" if parent is None else parent["path"]
        row = self._session.execute(
            text("UPDATE department SET path = :path WHERE id = :id RETURNING *"),
            {"id": row["id"], "path": f"{parent_path}{row['id']}/"},
        ).mappings().one()
        self._session.commit()
        return _department_view(row)

    def update_department(self, member: dict, department_id: int, payload: dict) -> dict:
        self.require_can_manage_department(member, department_id)
        row = self._session.execute(
            text(
                "UPDATE department SET name = COALESCE(:name, name),"
                " sort_order = COALESCE(:sort_order, sort_order), updated_at = now()"
                " WHERE id = :id RETURNING *"
            ),
            {"id": department_id, "name": payload.get("name"), "sort_order": payload.get("sortOrder")},
        ).mappings().one()
        self._session.commit()
        return _department_view(row)

    def delete_department(self, member: dict, department_id: int) -> None:
        department = self.require_can_manage_department(member, department_id)
        descendants = [
            node for node in self.self_and_descendants(department) if node["id"] != department_id
        ]
        if descendants:
            raise ApiError(ErrorCode.PARAM_INVALID, "请先删除下级部门")
        members = self._session.execute(
            text("SELECT count(*) FROM org_member WHERE department_id = :id"), {"id": department_id}
        ).scalar_one()
        if members:
            raise ApiError(ErrorCode.PARAM_INVALID, "部门下仍有成员，无法删除")
        self._session.execute(
            text("DELETE FROM department_manager WHERE department_id = :id"), {"id": department_id}
        )
        self._session.execute(text("DELETE FROM department WHERE id = :id"), {"id": department_id})
        self._session.commit()

    def grant_manager(self, member: dict, department_id: int, org_member_id: int) -> None:
        self.require_org_admin(member)
        department = self.require_department(member["org_id"], department_id)
        target = self.require_member(member["org_id"], org_member_id)
        self._session.execute(
            text(
                "INSERT INTO department_manager (department_id, org_member_id) VALUES (:dept, :member)"
                " ON CONFLICT (department_id, org_member_id) DO NOTHING"
            ),
            {"dept": department["id"], "member": target["id"]},
        )
        self._session.commit()

    def revoke_manager(self, member: dict, department_id: int, org_member_id: int) -> None:
        self.require_org_admin(member)
        self._session.execute(
            text(
                "DELETE FROM department_manager WHERE department_id = :dept AND org_member_id = :member"
            ),
            {"dept": department_id, "member": org_member_id},
        )
        self._session.commit()

    # ------------------------------------------------------------ 成员
    def require_member(self, org_id: int, member_id: int) -> dict:
        row = self._session.execute(
            text("SELECT * FROM org_member WHERE id = :id AND org_id = :org_id"),
            {"id": member_id, "org_id": org_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "成员不存在或不属于当前组织")
        return dict(row)

    def list_members(self, member: dict, department_id: int | None) -> list[dict]:
        scope = self.manageable_department_ids(member)
        params: dict = {"org_id": member["org_id"]}
        admin_actor = member.get("admin_id") is not None
        if not scope and not admin_actor:
            # 普通成员只能看到自己
            sql = "SELECT * FROM org_member WHERE org_id = :org_id AND id = :self_id"
            params["self_id"] = member["id"]
        elif department_id is not None:
            self.require_can_manage_department(member, department_id)
            sql = (
                "SELECT * FROM org_member WHERE org_id = :org_id AND department_id = :dept"
                " AND status <> 'LEFT'"
            )
            params["dept"] = department_id
        elif admin_actor:
            # 后台管理员看全组织；组织里还没有部门时也要能列出成员（新组织开张就是这个场景）
            sql = "SELECT * FROM org_member WHERE org_id = :org_id AND status <> 'LEFT'"
        else:
            sql = (
                "SELECT * FROM org_member WHERE org_id = :org_id"
                " AND department_id = ANY(:dept_ids) AND status <> 'LEFT'"
            )
            params["dept_ids"] = list(scope)
        rows = self._session.execute(text(sql + " ORDER BY id"), params).mappings().all()
        names = {d["id"]: d["name"] for d in self.all_departments(member["org_id"])}
        manager_ids = set(
            self._session.execute(
                text("SELECT org_member_id FROM department_manager WHERE org_member_id = ANY(:ids)"),
                {"ids": [row["id"] for row in rows] or [0]},
            ).scalars().all()
        )
        return [_member_view(row, names, row["id"] in manager_ids) for row in rows]

    def create_member(self, member: dict, payload: dict) -> dict:
        department = self.require_can_manage_department(member, payload["departmentId"])
        role = payload.get("orgRole") or "MEMBER"
        if role not in ("OWNER", "ADMIN", "MEMBER"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"组织角色取值非法: {role}")
        if role != "MEMBER":
            self.require_org_admin(member)
        created = self._create_member_row(
            member["org_id"], department["id"], payload["memberKey"], payload["realName"],
            payload.get("jobTitle"), role,
        )
        self._session.commit()
        names = {d["id"]: d["name"] for d in self.all_departments(member["org_id"])}
        return _member_view(created, names, False)

    def _create_member_row(
        self, org_id: int, department_id: int, member_key: str, real_name: str,
        job_title: str | None, role: str,
    ) -> dict:
        """创建成员：**只写成员唯一识别 ID**，不建账号、不建身份（spec §3.1）。

        身份等成员自己用「组织唯一 ID + 唯一识别 ID」认领组织账号时产生。
        """
        key = (member_key or "").strip()
        if not key:
            raise ApiError(ErrorCode.PARAM_MISSING, "成员唯一识别 ID 不能为空")
        duplicated = self._session.execute(
            text(
                "SELECT count(*) FROM org_member WHERE org_id = :org_id AND member_key = :key"
            ),
            {"org_id": org_id, "key": key},
        ).scalar_one()
        if duplicated:
            raise ApiError(ErrorCode.MEMBER_ALREADY_EXISTS, f"该唯一识别 ID 已经是本组织成员：{key}")
        row = self._session.execute(
            text(
                "INSERT INTO org_member (org_id, department_id, member_key, real_name,"
                " org_role, job_title, status) VALUES (:org_id, :department_id,"
                " :member_key, :real_name, :role, :job_title, 'ACTIVE') RETURNING *"
            ),
            {
                "org_id": org_id,
                "department_id": department_id,
                "member_key": key,
                "real_name": real_name,
                "role": role,
                "job_title": job_title,
            },
        ).mappings().one()
        return dict(row)

    def update_member(self, member: dict, member_id: int, payload: dict) -> dict:
        target = self.require_member(member["org_id"], member_id)
        if target["id"] != member["id"]:
            self.require_can_manage_department(member, target["department_id"])
        elif not self.is_org_admin(member):
            raise ApiError(ErrorCode.FORBIDDEN, "普通成员不能修改成员信息")
        if payload.get("departmentId") and payload["departmentId"] != target["department_id"]:
            self.require_can_manage_department(member, payload["departmentId"])
        if payload.get("orgRole"):
            self.require_org_admin(member)
            if target["org_role"] == "OWNER" and payload["orgRole"] != "OWNER":
                raise ApiError(ErrorCode.PARAM_INVALID, "拥有者不可被降级，请先转让拥有者")
        if payload.get("status"):
            self.require_org_admin(member)
            if target["org_role"] == "OWNER" and payload["status"] != "ACTIVE":
                raise ApiError(ErrorCode.PARAM_INVALID, "拥有者不可被停用")
        row = self._session.execute(
            text(
                "UPDATE org_member SET real_name = COALESCE(:real_name, real_name),"
                " department_id = COALESCE(:department_id, department_id),"
                " member_key = COALESCE(:member_key, member_key),"
                " job_title = COALESCE(:job_title, job_title),"
                " org_role = COALESCE(:org_role, org_role), status = COALESCE(:status, status),"
                " updated_at = now() WHERE id = :id RETURNING *"
            ),
            {
                "id": member_id,
                "real_name": payload.get("realName"),
                "department_id": payload.get("departmentId"),
                "member_key": payload.get("memberKey"),
                "job_title": payload.get("jobTitle"),
                "org_role": payload.get("orgRole"),
                "status": payload.get("status"),
            },
        ).mappings().one()
        if payload.get("status") and target["identity_id"] is not None:
            self._session.execute(
                text("UPDATE identity SET status = :status WHERE id = :id"),
                {
                    "id": target["identity_id"],
                    "status": "ACTIVE" if payload["status"] == "ACTIVE" else "DISABLED",
                },
            )
        self._session.commit()
        names = {d["id"]: d["name"] for d in self.all_departments(member["org_id"])}
        return _member_view(row, names, False)

    # ------------------------------------------------------ 组织账号解绑

    def unbind_member(self, member: dict, member_id: int) -> dict:
        """解绑成员的组织账号（spec §3.2）：成员换号或被冒领后的恢复路径。"""
        target = self.require_member(member["org_id"], member_id)
        self.require_can_manage_department(member, target["department_id"])
        self.unbind_member_row(target)
        self._session.commit()
        names = {d["id"]: d["name"] for d in self.all_departments(member["org_id"])}
        return _member_view(self.require_member(member["org_id"], member_id), names, False)

    def unbind_member_row(self, target: dict) -> None:
        """清掉认领关系、停用其组织身份并吊销会话。组织侧成员记录保留。"""
        identity_id = target["identity_id"]
        if identity_id is not None:
            self._session.execute(
                text("UPDATE identity SET status = 'DISABLED' WHERE id = :id"),
                {"id": identity_id},
            )
            if self._refresh_tokens is not None:
                # 会话必须一起吊销：否则「删掉登录记录」只删了 App 那一份，服务端令牌还能用
                self._refresh_tokens.revoke_all_for_identity(identity_id)
        self._session.execute(
            text("UPDATE org_member SET identity_id = NULL, updated_at = now() WHERE id = :id"),
            {"id": target["id"]},
        )

    # ------------------------------------------------------------ 组织日程
    def dispatch(self, member: dict, payload: dict) -> dict:
        if payload["endAt"] <= payload["startAt"]:
            raise ApiError(ErrorCode.EVENT_TIME_INVALID)
        if payload.get("rrule"):
            raise ApiError(ErrorCode.PARAM_INVALID, "首版组织日程暂不支持重复规则")
        recipients = self._with_initiator(self._resolve_recipients(member, payload), member)
        if not recipients:
            raise ApiError(ErrorCode.DISPATCH_TARGET_EMPTY)
        calendar_id = self._ensure_org_calendar(member)
        event = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, org_id, creator_identity_id, source_type, title,"
                " description, location_name, start_at, end_at, all_day, timezone, status,"
                " updated_after_dispatch) VALUES (:calendar_id, :org_id, :identity, 'ORG_DISPATCH',"
                " :title, :description, :location_name, :start_at, :end_at, :all_day, :timezone,"
                " 'CONFIRMED', false) RETURNING *"
            ),
            {
                "calendar_id": calendar_id,
                "org_id": member["org_id"],
                "identity": member["identity_id"],
                "title": payload["title"],
                "description": payload.get("description"),
                # 组织日程目前只用「地点名称」一个字段（V9 起该列叫 location_name）
                "location_name": payload.get("location"),
                "start_at": payload["startAt"],
                "end_at": payload["endAt"],
                "all_day": bool(payload.get("allDay")),
                "timezone": payload.get("timezone") or member["org_timezone"],
            },
        ).mappings().one()
        dispatch = self._session.execute(
            text(
                "INSERT INTO event_dispatch (event_id, org_id, scope_type, department_id,"
                " include_sub_departments, require_receipt, created_by_member_id,"
                " created_by_admin_id, status, recipient_count) VALUES (:event_id, :org_id,"
                " :scope_type, :department_id, :include_sub, :require_receipt, :member_id,"
                " :admin_id, 'ACTIVE', :count) RETURNING *"
            ),
            {
                "event_id": event["id"],
                "org_id": member["org_id"],
                "scope_type": payload["scopeType"],
                "department_id": payload.get("departmentId"),
                # 注意：model_dump() 会带上值为 None 的可选字段，因此要先判 None 再取默认
                "include_sub": True
                if payload.get("includeSubDepartments") is None
                else bool(payload["includeSubDepartments"]),
                "require_receipt": bool(payload.get("requireReceipt")),
                # 发起方二选一：成员（App）记成员 id，后台管理员（Web）记 admin_user id（spec §5.6）
                "member_id": member["id"],
                "admin_id": member.get("admin_id"),
                "count": len(recipients),
            },
        ).mappings().one()
        self._session.execute(
            text("UPDATE event SET dispatch_id = :dispatch_id WHERE id = :id"),
            {"dispatch_id": dispatch["id"], "id": event["id"]},
        )
        for recipient in recipients:
            self._session.execute(
                text(
                    "INSERT INTO event_recipient (dispatch_id, event_id, org_member_id,"
                    " department_id, receipt_status) VALUES (:dispatch_id, :event_id, :member_id,"
                    " :department_id, 'PENDING')"
                ),
                {
                    "dispatch_id": dispatch["id"],
                    "event_id": event["id"],
                    "member_id": recipient["id"],
                    "department_id": recipient["department_id"],
                },
            )
        self._session.commit()
        return _org_event_view(event, dispatch, None)

    def _resolve_recipients(self, member: dict, payload: dict) -> list[dict]:
        scope = payload["scopeType"]
        if scope == "ALL":
            self.require_org_admin(member)
            return self._active_members(member["org_id"], None)
        if scope == "DEPARTMENT":
            department_id = payload.get("departmentId")
            if department_id is None:
                raise ApiError(ErrorCode.PARAM_INVALID, "departmentId 不能为空")
            department = self.require_can_manage_department(member, department_id)
            include_sub = payload.get("includeSubDepartments")
            if include_sub is None or include_sub:
                scope_ids = [node["id"] for node in self.self_and_descendants(department)]
            else:
                scope_ids = [department["id"]]
            return self._active_members(member["org_id"], scope_ids)
        if scope == "MEMBER":
            member_ids = payload.get("memberIds") or []
            if not member_ids:
                raise ApiError(ErrorCode.DISPATCH_TARGET_EMPTY)
            targets = [
                self.require_member(member["org_id"], member_id) for member_id in set(member_ids)
            ]
            manageable = self.manageable_department_ids(member)
            for target in targets:
                if target["department_id"] not in manageable:
                    raise ApiError(ErrorCode.FORBIDDEN, "无权向该成员下发日程")
            return targets
        raise ApiError(ErrorCode.PARAM_INVALID, f"下发范围取值非法: {scope}")

    def _active_members(self, org_id: int, department_ids: list[int] | None) -> list[dict]:
        params: dict = {"org_id": org_id}
        sql = "SELECT * FROM org_member WHERE org_id = :org_id AND status = 'ACTIVE'"
        if department_ids is not None:
            sql += " AND department_id = ANY(:dept_ids)"
            params["dept_ids"] = department_ids
        return [dict(row) for row in self._session.execute(text(sql), params).mappings()]

    def _with_initiator(self, recipients: list[dict], member: dict) -> list[dict]:
        """下发对象里永远包含**发起人自己**（spec §4.2.2）。

        组织 tab 的列表口径是「发给我 / 我参与的」：发起人不在收件名单里，
        自己刚下发的东西下一秒在自己日历里就看不见了。后台管理员没有 org_member 记录，自然不参与。
        """
        if member.get("id") is None:
            return recipients
        if any(item["id"] == member["id"] for item in recipients):
            return recipients
        self_row = self._session.execute(
            text("SELECT * FROM org_member WHERE id = :id AND status = 'ACTIVE'"),
            {"id": member["id"]},
        ).mappings().first()
        if self_row is None:
            return recipients
        return [*recipients, dict(self_row)]

    def _ensure_org_calendar(self, member: dict) -> int:
        existing = self._session.execute(
            text(
                "SELECT id FROM calendar WHERE calendar_type = 'ORG' AND org_id = :org_id"
                " AND status = 'ACTIVE' LIMIT 1"
            ),
            {"org_id": member["org_id"]},
        ).scalar()
        if existing:
            return int(existing)
        return int(
            self._session.execute(
                text(
                    "INSERT INTO calendar (calendar_type, org_id, name, color, timezone,"
                    " is_default, status) VALUES ('ORG', :org_id, '组织日历', '#0A0A0A', :timezone,"
                    " true, 'ACTIVE') RETURNING id"
                ),
                {"org_id": member["org_id"], "timezone": member["org_timezone"]},
            ).scalar_one()
        )

    def list_org_events(self, member: dict, start: datetime, end: datetime) -> list[dict]:
        rows = self._session.execute(
            text(
                "SELECT r.*, d.scope_type, d.department_id, d.require_receipt,"
                " d.created_by_member_id, d.created_by_admin_id, e.* FROM event_recipient r"
                " JOIN event_dispatch d ON d.id = r.dispatch_id"
                " JOIN event e ON e.id = r.event_id"
                " WHERE r.org_member_id = :member_id AND d.status = 'ACTIVE'"
                "   AND e.deleted_at IS NULL AND e.status <> 'CANCELLED'"
            ),
            {"member_id": member["id"]},
        ).mappings().all()
        result: list[dict] = []
        for row in rows:
            # 「编辑」入口显不显示由服务端判定，App 不猜权限（spec §4.2.2）
            can_edit = self.is_initiator(member, row)
            event = {
                "id": row["event_id"],
                "calendar_id": row["calendar_id"],
                "title": row["title"],
                "location": row["location_name"],
                "start_at": row["start_at"],
                "end_at": row["end_at"],
                "all_day": row["all_day"],
                "timezone": row["timezone"],
                "rrule": row["rrule"],
                "description": row["description"],
            }
            for occurrence in recurrence.expand(event, [], start, end):
                result.append(
                    {
                        "eventId": event["id"],
                        "dispatchId": row["dispatch_id"],
                        "title": occurrence["title"],
                        "description": event["description"],
                        "location": occurrence["locationName"],
                        "startAt": occurrence["startAt"],
                        "endAt": occurrence["endAt"],
                        "allDay": occurrence["allDay"],
                        "timezone": occurrence["timezone"],
                        "rrule": event["rrule"],
                        "requireReceipt": bool(row["require_receipt"]),
                        "receiptStatus": row["receipt_status"],
                        "receiptAt": row["receipt_at"],
                        "remark": row["remark"],
                        "read": row["read_at"] is not None,
                        "canEdit": can_edit,
                    }
                )
        result.sort(key=lambda item: (item["startAt"], item["eventId"]))
        return result

    def submit_receipt(self, member: dict, event_id: int, status: str, remark: str | None) -> dict:
        if status not in ("ACCEPTED", "DECLINED", "COMPLETED"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"回执状态取值非法: {status}")
        row = self._session.execute(
            text(
                "SELECT r.*, d.status AS dispatch_status, d.require_receipt, e.* FROM event_recipient r"
                " JOIN event_dispatch d ON d.id = r.dispatch_id"
                " JOIN event e ON e.id = r.event_id"
                " WHERE r.event_id = :event_id AND r.org_member_id = :member_id"
            ),
            {"event_id": event_id, "member_id": member["id"]},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "该日程未下发给当前成员")
        if row["dispatch_status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "该下发已撤回")
        self._session.execute(
            text(
                "UPDATE event_recipient SET receipt_status = :status, receipt_at = now(),"
                " remark = :remark, read_at = COALESCE(read_at, now()), updated_at = now()"
                " WHERE id = :id"
            ),
            {"id": row["id"], "status": status, "remark": remark},
        )
        self._session.commit()
        return {
            "eventId": row["event_id"],
            "dispatchId": row["dispatch_id"],
            "title": row["title"],
            "description": row["description"],
            "location": row["location_name"],
            "startAt": row["start_at"],
            "endAt": row["end_at"],
            "allDay": bool(row["all_day"]),
            "timezone": row["timezone"],
            "rrule": row["rrule"],
            "requireReceipt": bool(row["require_receipt"]),
            "receiptStatus": status,
            "receiptAt": datetime.now(),
            "remark": remark,
            "read": True,
        }

    def mark_read(self, member: dict, event_id: int) -> None:
        result = self._session.execute(
            text(
                "UPDATE event_recipient SET read_at = COALESCE(read_at, now())"
                " WHERE event_id = :event_id AND org_member_id = :member_id"
            ),
            {"event_id": event_id, "member_id": member["id"]},
        )
        if result.rowcount == 0:
            raise ApiError(ErrorCode.FORBIDDEN, "该日程未下发给当前成员")
        self._session.commit()

    def receipt_summary(self, member: dict, event_id: int) -> dict:
        dispatch = self._require_active_dispatch(member["org_id"], event_id)
        # 走共用判定：这里原来是照抄一遍的权限规则，加了「发起人」之后立刻就不一致了
        self._require_can_view_dispatch(member, dispatch)
        rows = self._session.execute(
            text(
                "SELECT r.*, m.real_name, d.name AS department_name FROM event_recipient r"
                " LEFT JOIN org_member m ON m.id = r.org_member_id"
                " LEFT JOIN department d ON d.id = r.department_id"
                " WHERE r.dispatch_id = :dispatch_id ORDER BY r.id"
            ),
            {"dispatch_id": dispatch["id"]},
        ).mappings().all()
        counts = {"PENDING": 0, "ACCEPTED": 0, "DECLINED": 0, "COMPLETED": 0}
        read_count = 0
        items = []
        for row in rows:
            counts[row["receipt_status"]] = counts.get(row["receipt_status"], 0) + 1
            if row["read_at"]:
                read_count += 1
            items.append(
                {
                    "orgMemberId": row["org_member_id"],
                    "realName": row["real_name"],
                    "departmentName": row["department_name"],
                    "receiptStatus": row["receipt_status"],
                    "receiptAt": row["receipt_at"],
                    "remark": row["remark"],
                    "read": row["read_at"] is not None,
                }
            )
        return {
            "dispatchId": dispatch["id"],
            "eventId": event_id,
            "scopeType": dispatch["scope_type"],
            "requireReceipt": bool(dispatch["require_receipt"]),
            "total": len(rows),
            "pending": counts["PENDING"],
            "accepted": counts["ACCEPTED"],
            "declined": counts["DECLINED"],
            "completed": counts["COMPLETED"],
            "readCount": read_count,
            "items": items,
        }

    def _require_active_dispatch(self, org_id: int, event_id: int) -> dict:
        row = self._session.execute(
            text(
                "SELECT * FROM event_dispatch WHERE event_id = :event_id AND org_id = :org_id"
                " AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1"
            ),
            {"event_id": event_id, "org_id": org_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "该日程没有有效的下发记录")
        return dict(row)

    def revoke_dispatch(self, member: dict, event_id: int) -> None:
        dispatch = self._require_active_dispatch(member["org_id"], event_id)
        self.require_is_initiator(member, dispatch)
        receipted = self._session.execute(
            text(
                "SELECT count(*) FROM event_recipient WHERE dispatch_id = :id"
                " AND receipt_status <> 'PENDING'"
            ),
            {"id": dispatch["id"]},
        ).scalar_one()
        if receipted:
            raise ApiError(ErrorCode.DISPATCH_ALREADY_RECEIPTED)
        self._session.execute(
            text("UPDATE event_dispatch SET status = 'REVOKED' WHERE id = :id"), {"id": dispatch["id"]}
        )
        self._session.commit()

    def update_org_event(self, member: dict, event_id: int, payload: dict) -> dict:
        dispatch = self._require_active_dispatch(member["org_id"], event_id)
        self.require_is_initiator(member, dispatch)
        row = self._session.execute(
            text(
                "UPDATE event SET title = COALESCE(:title, title),"
                " description = COALESCE(:description, description),"
                " location_name = COALESCE(:location_name, location_name),"
                " start_at = COALESCE(:start_at, start_at), end_at = COALESCE(:end_at, end_at),"
                " all_day = COALESCE(:all_day, all_day),"
                " timezone = COALESCE(:timezone, timezone), updated_after_dispatch = true,"
                " updated_at = now() WHERE id = :id RETURNING *"
            ),
            {
                "id": event_id,
                "title": payload.get("title"),
                "description": payload.get("description"),
                "location_name": payload.get("location"),
                "start_at": payload.get("startAt"),
                "end_at": payload.get("endAt"),
                "all_day": payload.get("allDay"),
                "timezone": payload.get("timezone"),
            },
        ).mappings().one()
        self._session.commit()
        return _org_event_view(row, dispatch, None)

    def delete_org_event(self, member: dict, event_id: int) -> None:
        dispatch = self._require_active_dispatch(member["org_id"], event_id)
        self.require_is_initiator(member, dispatch)
        self._session.execute(
            text(
                "UPDATE event SET deleted_at = now(), status = 'CANCELLED' WHERE id = :id"
            ),
            {"id": event_id},
        )
        self._session.execute(
            text("UPDATE event_dispatch SET status = 'REVOKED' WHERE id = :id"), {"id": dispatch["id"]}
        )
        self._session.commit()

    def _require_can_view_dispatch(self, member: dict, dispatch: dict) -> None:
        if self.can_view_dispatch_stats(member, dispatch):
            return
        raise ApiError(ErrorCode.FORBIDDEN, "无权查看该下发的回执")

    def is_initiator(self, member: dict, dispatch: dict) -> bool:
        """我是不是这条下发的**发起人**（spec §4.2.2）。"""
        if member.get("admin_id") is not None:
            return dispatch.get("created_by_admin_id") == member["admin_id"]
        return member.get("id") is not None and dispatch.get("created_by_member_id") == member["id"]

    def require_is_initiator(self, member: dict, dispatch: dict) -> None:
        """改 / 撤 / 删**只有发起人本人**能做，组织管理员也不行：
        已经发给别人的通知，内容该由发的人负责。
        """
        if not self.is_initiator(member, dispatch):
            raise ApiError(ErrorCode.FORBIDDEN, "只有下发者本人可以修改这条组织日程")

    def can_view_dispatch_stats(self, member: dict, dispatch: dict) -> bool:
        """回执统计是**读**：组织管理员、被授权部门的负责人、以及发起人都看得到。"""
        if self.is_org_admin(member) or self.is_initiator(member, dispatch):
            return True
        return (
            dispatch["scope_type"] == "DEPARTMENT"
            and dispatch["department_id"] is not None
            and dispatch["department_id"] in self.manageable_department_ids(member)
        )

    # ------------------------------------------------------- 组织管理端（Web）
    def admin_event_list(self, member: dict, start: datetime, end: datetime) -> list[dict]:
        """组织管理端的组织日程列表（spec §6.3 `GET /org-admin/events`）。

        与管理端下拉一致：只列**活跃下发**，并附回执分布。
        """
        self.require_org_admin(member)
        rows = self._session.execute(
            text(
                "SELECT e.*, d.id AS dispatch_id, d.scope_type, d.department_id,"
                " d.require_receipt, d.recipient_count FROM event e"
                " JOIN event_dispatch d ON d.event_id = e.id AND d.status = 'ACTIVE'"
                " WHERE e.org_id = :org_id AND e.deleted_at IS NULL"
                " AND e.start_at < :end AND e.end_at > :start ORDER BY e.start_at"
            ),
            {"org_id": member["org_id"], "start": start, "end": end},
        ).mappings().all()
        if not rows:
            return []
        dispatch_ids = [row["dispatch_id"] for row in rows]
        receipts = self._session.execute(
            text(
                "SELECT dispatch_id, receipt_status, count(*) AS total FROM event_recipient"
                " WHERE dispatch_id = ANY(:ids) GROUP BY dispatch_id, receipt_status"
            ),
            {"ids": dispatch_ids},
        ).mappings().all()
        tally: dict[int, dict[str, int]] = {}
        for row in receipts:
            tally.setdefault(row["dispatch_id"], {})[row["receipt_status"]] = row["total"]

        result = []
        for row in rows:
            counts = tally.get(row["dispatch_id"], {})
            result.append(
                {
                    "eventId": row["id"],
                    "dispatchId": row["dispatch_id"],
                    "title": row["title"],
                    "description": row["description"],
                    "location": row["location_name"],
                    "startAt": row["start_at"],
                    "endAt": row["end_at"],
                    "allDay": bool(row["all_day"]),
                    "timezone": row["timezone"],
                    "scopeType": row["scope_type"],
                    "departmentId": row["department_id"],
                    "requireReceipt": bool(row["require_receipt"]),
                    "recipientCount": row["recipient_count"],
                    "pendingCount": counts.get("PENDING", 0),
                    "acceptedCount": counts.get("ACCEPTED", 0),
                    "declinedCount": counts.get("DECLINED", 0),
                    "completedCount": counts.get("COMPLETED", 0),
                }
            )
        return result

    def org_settings(self, member: dict) -> dict:
        """组织设置（spec §4.3）：成员上限只读，由平台超管在 §4.4 控制。"""
        self.require_org_admin(member)
        org = self._require_active_org(member["org_id"])
        member_count = self._session.execute(
            text(
                "SELECT count(*) FROM org_member WHERE org_id = :org_id AND status <> 'LEFT'"
            ),
            {"org_id": member["org_id"]},
        ).scalar_one()
        return _settings_view(org, member_count)

    def update_org_settings(self, member: dict, payload: dict) -> dict:
        self.require_org_admin(member)
        org = self._require_active_org(member["org_id"])
        if payload.get("timezone"):
            from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

            try:
                ZoneInfo(payload["timezone"])
            except (ZoneInfoNotFoundError, ValueError):
                raise ApiError(ErrorCode.PARAM_INVALID, f"时区不合法: {payload['timezone']}") from None
        self._session.execute(
            text(
                "UPDATE organization SET name = COALESCE(NULLIF(:name, ''), name),"
                " logo_url = COALESCE(:logo, logo_url),"
                " contact_name = COALESCE(:contact_name, contact_name),"
                " contact_phone = COALESCE(:contact_phone, contact_phone),"
                " timezone = COALESCE(NULLIF(:timezone, ''), timezone), updated_at = now()"
                " WHERE id = :id"
            ),
            {
                "name": payload.get("name") or "",
                "logo": payload.get("logoUrl"),
                "contact_name": payload.get("contactName"),
                "contact_phone": payload.get("contactPhone"),
                "timezone": payload.get("timezone") or "",
                "id": org["id"],
            },
        )
        self._session.commit()
        return self.org_settings(member)

    def _require_active_org(self, org_id: int) -> dict:
        org = self._session.execute(
            text("SELECT * FROM organization WHERE id = :id AND deleted_at IS NULL"),
            {"id": org_id},
        ).mappings().first()
        if org is None or org["status"] != "ACTIVE":
            raise ApiError(ErrorCode.FORBIDDEN, "组织已停用")
        return dict(org)

    def audit_logs(self, member: dict, action: str | None, limit: int) -> list[dict]:
        """本组织的操作日志（spec §6.3）。只服务后台组织管理员：App 里没有这个页面。"""
        if member.get("admin_id") is None:
            raise ApiError(ErrorCode.FORBIDDEN, "该接口只服务后台组织管理员")
        params: dict = {"org_id": member["org_id"]}
        sql = "SELECT * FROM audit_log WHERE org_id = :org_id"
        if action:
            sql += " AND action = :action"
            params["action"] = action
        sql += " ORDER BY id DESC LIMIT :limit"
        params["limit"] = max(1, min(limit, 500))
        rows = self._session.execute(text(sql), params).mappings().all()
        return [
            {
                "id": row["id"],
                "actorType": row["actor_type"],
                "actorName": row["actor_name"],
                "orgId": row["org_id"],
                "action": row["action"],
                "targetType": row["target_type"],
                "targetId": row["target_id"],
                "detail": row["detail"],
                "ip": row["ip"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def import_failures_csv(self, member: dict, batch_id: int) -> str:
        """失败明细导出为 CSV，便于修正后重传（spec §6.3）。"""
        self.require_org_admin(member)
        detail = self.import_detail(member, batch_id)
        lines = ["行号,原始数据,失败原因"]
        for row in detail["rows"]:
            if row["status"] != "FAILED":
                continue
            raw = (row["rawData"] or "").replace('"', '""')
            reason = (row["errorMessage"] or "").replace('"', '""')
            lines.append(f'{row["rowNo"]},"{raw}","{reason}"')
        return "\n".join(lines) + "\n"

    # ------------------------------------------------------------ 成员导入
    def import_members(self, member: dict, file_name: str, content: bytes, auto_create: bool) -> dict:
        # 批量导入是组织管理员的权限（spec §2.2 权限矩阵）
        self.require_org_admin(member)
        rows = _parse_import_file(file_name, content)
        if not rows:
            raise ApiError(ErrorCode.PARAM_INVALID, "文件中没有可导入的数据行")
        if len(rows) > 5000:
            raise ApiError(ErrorCode.PARAM_INVALID, f"单次导入最多 5000 行，当前 {len(rows)} 行")

        batch = self._session.execute(
            text(
                "INSERT INTO import_batch (org_id, file_name, file_url, total_count, success_count,"
                " fail_count, status, created_by_member_id, created_by_admin_id) VALUES (:org_id,"
                " :file_name, :file_url, :total, 0, 0, 'PROCESSING', :member_id, :admin_id)"
                " RETURNING id"
            ),
            {
                "org_id": member["org_id"],
                "file_name": file_name,
                "file_url": f"memory://{file_name}",
                "total": len(rows),
                "member_id": member["id"],
                "admin_id": member.get("admin_id"),
            },
        ).scalar_one()
        self._session.commit()

        success = 0
        failed = 0
        for row in rows:
            try:
                self._import_row(member, row, auto_create)
                self._record_import_row(batch, row, "SUCCESS", None)
                success += 1
            except ApiError as exc:
                self._record_import_row(batch, row, "FAILED", str(exc))
                failed += 1
            except Exception:  # noqa: BLE001 - 单行失败不影响整批
                self._session.rollback()
                self._record_import_row(batch, row, "FAILED", "数据冲突：该手机号或工号可能已存在")
                failed += 1
            self._session.commit()

        status = "SUCCESS" if failed == 0 else ("FAILED" if success == 0 else "PARTIAL_FAILED")
        self._session.execute(
            text(
                "UPDATE import_batch SET success_count = :success, fail_count = :failed,"
                " status = :status, finished_at = now() WHERE id = :id"
            ),
            {"id": batch, "success": success, "failed": failed, "status": status},
        )
        self._session.commit()
        return self.import_detail(member, batch)

    def _import_row(self, member: dict, row: dict, auto_create: bool) -> None:
        if not row.get("realName"):
            raise ApiError(ErrorCode.PARAM_INVALID, "姓名不能为空")
        # 成员唯一识别 ID 就是组织账号的登录凭据，缺了这行没有任何意义
        if not row.get("memberKey"):
            raise ApiError(ErrorCode.PARAM_INVALID, "成员唯一识别 ID（学号/工号）不能为空")
        if not row.get("departmentPath"):
            raise ApiError(ErrorCode.PARAM_INVALID, "部门路径不能为空")
        department = self._resolve_department_path(member, row["departmentPath"], auto_create)
        if department["id"] not in self.manageable_department_ids(member):
            raise ApiError(ErrorCode.FORBIDDEN, "无权向该部门导入成员")
        role = (row.get("role") or "MEMBER").upper()
        if role not in ("OWNER", "ADMIN", "MEMBER"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"角色取值非法: {row.get('role')}")
        if role != "MEMBER":
            self.require_org_admin(member)
        self._create_member_row(
            member["org_id"], department["id"], row.get("memberKey"), row["realName"], None, role,
        )

    def _resolve_department_path(self, member: dict, path: str, auto_create: bool) -> dict:
        current = None
        for segment in path.split("/"):
            name = segment.strip()
            if not name:
                continue
            params = {"org_id": member["org_id"], "name": name}
            if current is None:
                sql = "SELECT * FROM department WHERE org_id = :org_id AND name = :name AND parent_id IS NULL"
            else:
                sql = ("SELECT * FROM department WHERE org_id = :org_id AND name = :name"
                       " AND parent_id = :parent_id")
                params["parent_id"] = current["id"]
            found = self._session.execute(text(sql + " LIMIT 1"), params).mappings().first()
            if found is None:
                if not auto_create:
                    raise ApiError(ErrorCode.PARAM_INVALID, f"部门路径不存在: {path}")
                created = self.create_department(
                    member,
                    {"parentId": current["id"] if current else None, "name": name, "sortOrder": 0},
                )
                found = self.require_department(member["org_id"], created["id"])
            current = dict(found)
        if current is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "部门路径不能为空")
        return current

    def _record_import_row(self, batch_id: int, row: dict, status: str, error: str | None) -> None:
        self._session.execute(
            text(
                "INSERT INTO import_row_result (batch_id, row_no, raw_data, status, error_message)"
                " VALUES (:batch_id, :row_no, :raw_data, :status, :error)"
            ),
            {
                "batch_id": batch_id,
                "row_no": row["rowNo"],
                "raw_data": json_dumps(row),
                "status": status,
                "error": error,
            },
        )
        self._session.commit()

    def import_detail(self, member: dict, batch_id: int) -> dict:
        batch = self._session.execute(
            text("SELECT * FROM import_batch WHERE id = :id AND org_id = :org_id"),
            {"id": batch_id, "org_id": member["org_id"]},
        ).mappings().first()
        if batch is None:
            raise ApiError(ErrorCode.FORBIDDEN, "导入批次不存在或不属于当前组织")
        rows = self._session.execute(
            text(
                "SELECT * FROM import_row_result WHERE batch_id = :id ORDER BY row_no"
            ),
            {"id": batch_id},
        ).mappings()
        return {
            "batchId": batch["id"],
            "fileName": batch["file_name"],
            "status": batch["status"],
            "totalCount": batch["total_count"],
            "successCount": batch["success_count"],
            "failCount": batch["fail_count"],
            "createdAt": batch["created_at"],
            "finishedAt": batch["finished_at"],
            "rows": [
                {
                    "rowNo": row["row_no"],
                    "status": row["status"],
                    "errorMessage": row["error_message"],
                    "createdMemberId": row["created_member_id"],
                    "rawData": json_dumps(row["raw_data"]),
                }
                for row in rows
            ],
        }

    def list_imports(self, member: dict) -> list[dict]:
        rows = self._session.execute(
            text("SELECT * FROM import_batch WHERE org_id = :org_id ORDER BY id DESC"),
            {"org_id": member["org_id"]},
        ).mappings()
        return [
            {
                "batchId": row["id"],
                "fileName": row["file_name"],
                "status": row["status"],
                "totalCount": row["total_count"],
                "successCount": row["success_count"],
                "failCount": row["fail_count"],
                "createdAt": row["created_at"],
                "finishedAt": row["finished_at"],
            }
            for row in rows
        ]

    def import_template(self) -> bytes:
        from io import BytesIO

        from openpyxl import Workbook

        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "成员导入"
        # 模板列与 Java 版、spec §4.3 一致：只留「姓名 + 唯一识别 ID + 部门路径 + 角色」，
        # 手机号与邮箱不再是组织侧必填（组织账号不依赖手机号，spec §3.1）
        headers = ["姓名", "成员唯一识别 ID（学号/工号）", "部门路径", "角色"]
        sheet.append(headers)
        sheet.append(["张三", "E1001", "技术中心/后端组", "MEMBER"])
        output = BytesIO()
        workbook.save(output)
        return output.getvalue()

    def current_context(self, member: dict) -> dict:
        department = self.require_department(member["org_id"], member["department_id"])
        return {
            "orgId": member["org_id"],
            "orgName": member["org_name"],
            "orgCode": member["org_code"],
            "orgLogoUrl": member["org_logo_url"],
            "orgTimezone": member["org_timezone"],
            "memberId": member["id"],
            "realName": member["real_name"],
            "memberKey": member["member_key"],
            "jobTitle": member["job_title"],
            "orgRole": member["org_role"],
            "departmentId": department["id"],
            "departmentName": department["name"],
            "departmentPathNames": _path_names(self, department),
            "orgAdmin": self.is_org_admin(member),
            "manageableDepartmentIds": sorted(self.manageable_department_ids(member)),
        }


def _parse_import_file(file_name: str, content: bytes) -> list[dict]:
    if not content:
        raise ApiError(ErrorCode.PARAM_INVALID, "上传文件为空")
    lower = (file_name or "").lower()
    if lower.endswith(".csv"):
        return _parse_csv(content)
    if lower.endswith(".xlsx"):
        return _parse_xlsx(content)
    raise ApiError(ErrorCode.PARAM_INVALID, "仅支持 .xlsx 或 .csv 文件")


def _parse_csv(content: bytes) -> list[dict]:
    import csv
    from io import StringIO

    text_content = content.decode("utf-8-sig")
    rows: list[dict] = []
    for index, raw in enumerate(csv.reader(StringIO(text_content))):
        if index == 0 or not any(cell.strip() for cell in raw):
            continue
        padded = list(raw) + [""] * (6 - len(raw))
        rows.append(_import_row(index + 1, padded))
    return rows


def _parse_xlsx(content: bytes) -> list[dict]:
    from io import BytesIO

    from openpyxl import load_workbook

    workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
    sheet = workbook.worksheets[0]
    rows: list[dict] = []
    for index, raw in enumerate(sheet.iter_rows(values_only=True)):
        if index == 0 or raw is None or not any(cell is not None and str(cell).strip() for cell in raw):
            continue
        values = ["" if cell is None else str(cell).strip() for cell in raw]
        values += [""] * (6 - len(values))
        rows.append(_import_row(index + 1, values))
    return rows


def _import_row(row_no: int, values: list[str]) -> dict:
    return {
        "rowNo": row_no,
        "realName": values[0] or None,
        "memberKey": values[1] or None,
        "departmentPath": values[2] or None,
        "role": values[3] or None,
    }


def json_dumps(value) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, default=str)


def _path_names(service: OrgService, department: dict) -> list[str]:
    names = []
    for segment in department["path"].split("/"):
        if segment.strip():
            node = service.require_department(department["org_id"], int(segment))
            names.append(node["name"])
    return names or [department["name"]]


def _build_nodes(parent_id, children: dict) -> list[dict]:
    nodes = children.get(parent_id) or []
    return [
        {
            "id": node["id"],
            "parentId": node["parent_id"],
            "name": node["name"],
            "level": node["level"],
            "path": node["path"],
            "sortOrder": node["sort_order"],
            "children": _build_nodes(node["id"], children),
        }
        for node in sorted(nodes, key=lambda item: (item["sort_order"] or 0, item["id"]))
    ]


def _department_view(row) -> dict:
    return {
        "id": row["id"],
        "orgId": row["org_id"],
        "parentId": row["parent_id"],
        "name": row["name"],
        "path": row["path"],
        "level": row["level"],
        "sortOrder": row["sort_order"],
        "status": row["status"],
    }


def _settings_view(org: dict, member_count: int) -> dict:
    return {
        "orgId": org["id"],
        "name": org["name"],
        "code": org["code"],
        "logoUrl": org["logo_url"],
        "contactName": org["contact_name"],
        "contactPhone": org["contact_phone"],
        "timezone": org["timezone"],
        "status": org["status"],
        # 成员上限只读：由平台超管在 spec §4.4 控制，组织侧不能自行上调
        "maxMembers": org["max_members"],
        "memberCount": member_count,
    }


def _member_view(row, department_names: dict, is_manager: bool) -> dict:
    return {
        "id": row["id"],
        "identityId": row["identity_id"],
        "departmentId": row["department_id"],
        "departmentName": department_names.get(row["department_id"]),
        "realName": row["real_name"],
        "memberKey": row["member_key"],
        # 是否已被某个个人账号认领：管理端要能一眼看出谁还没进来
        "bound": row["identity_id"] is not None,
        "jobTitle": row["job_title"],
        "orgRole": row["org_role"],
        "status": row["status"],
        "departmentManager": is_manager,
    }


def _org_event_view(event, dispatch, receipt, can_edit: bool = True) -> dict:
    """组织日程的响应体。

    `can_edit` 默认 True：调用方能拿到这个返回体，说明刚刚通过了权限校验
    （下发 / 修改 / 提交回执），对自己刚动过的东西当然可编辑。
    """
    return {
        "eventId": event["id"],
        "dispatchId": dispatch["id"],
        "title": event["title"],
        "description": event["description"],
        "location": event["location_name"],
        "startAt": event["start_at"],
        "endAt": event["end_at"],
        "allDay": bool(event["all_day"]),
        "timezone": event["timezone"],
        "rrule": event["rrule"],
        "requireReceipt": bool(dispatch["require_receipt"]),
        "receiptStatus": receipt["receipt_status"] if receipt else None,
        "receiptAt": receipt["receipt_at"] if receipt else None,
        "remark": receipt["remark"] if receipt else None,
        "read": bool(receipt and receipt["read_at"]),
        "canEdit": can_edit,
    }
