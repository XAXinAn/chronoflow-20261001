"""平台超管后台（spec §4.4）。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import bcrypt
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..errors import ApiError, ErrorCode
from ..security import AdminPrincipal, issue_admin_token

MAX_FAILED_ATTEMPTS = 5
LOCK_MINUTES = 15


class AdminService:
    def __init__(self, session: Session):
        self._session = session

    # ---------------------------------------------------------------- 登录
    def login(self, username: str, password: str, ip: str | None, user_agent: str | None) -> dict:
        admin = self._session.execute(
            text("SELECT * FROM admin_user WHERE username = :username"), {"username": username}
        ).mappings().first()
        now = datetime.now(timezone.utc)
        if admin is None:
            self._record_login(None, "FAIL", "用户名不存在", ip, user_agent)
            raise ApiError(ErrorCode.ADMIN_LOGIN_FAILED)
        if admin["locked_until"] and admin["locked_until"] > now:
            self._record_login(admin["id"], "FAIL", "账号已锁定", ip, user_agent)
            raise ApiError(ErrorCode.ADMIN_LOGIN_FAILED, "账号已锁定，请稍后再试")
        if admin["status"] == "DISABLED":
            self._record_login(admin["id"], "FAIL", "账号已停用", ip, user_agent)
            raise ApiError(ErrorCode.ADMIN_LOGIN_FAILED, "账号已停用")

        if not bcrypt.checkpw(password.encode(), admin["password_hash"].encode()):
            failures = (admin["failed_login_count"] or 0) + 1
            self._session.execute(
                text(
                    "UPDATE admin_user SET failed_login_count = :count, locked_until = :locked"
                    " WHERE id = :id"
                ),
                {
                    "id": admin["id"],
                    "count": failures,
                    "locked": now + timedelta(minutes=LOCK_MINUTES)
                    if failures >= MAX_FAILED_ATTEMPTS
                    else admin["locked_until"],
                },
            )
            self._session.commit()
            self._record_login(admin["id"], "FAIL", "密码错误", ip, user_agent)
            raise ApiError(ErrorCode.ADMIN_LOGIN_FAILED)
        # 登录刻意不开事务：失败分支会抛异常，若在事务里会把刚写入的失败计数一并回滚，
        # 导致锁定永不生效（Java 版踩过这个坑）。
        self._session.execute(
            text(
                "UPDATE admin_user SET failed_login_count = 0, locked_until = NULL,"
                " last_login_at = now() WHERE id = :id"
            ),
            {"id": admin["id"]},
        )
        self._session.commit()
        self._record_login(admin["id"], "SUCCESS", None, ip, user_agent)
        principal = AdminPrincipal(admin["id"], admin["username"], admin["role"], admin["org_id"])
        self.record_audit(principal, "ADMIN_LOGIN", "ADMIN_USER", admin["id"], None)
        return {
            "accessToken": issue_admin_token(
                admin["id"], admin["username"], admin["role"], admin["org_id"]
            ),
            "expiresIn": settings.access_token_ttl,
            "admin": _admin_view(admin),
        }

    def me(self, principal: AdminPrincipal) -> dict:
        return _admin_view(self._require_admin(principal.admin_id))

    def change_password(self, principal: AdminPrincipal, old_password: str, new_password: str) -> None:
        admin = self._require_admin(principal.admin_id)
        if not bcrypt.checkpw(old_password.encode(), admin["password_hash"].encode()):
            raise ApiError(ErrorCode.ADMIN_LOGIN_FAILED, "原密码不正确")
        self._session.execute(
            text("UPDATE admin_user SET password_hash = :hash WHERE id = :id"),
            {"id": admin["id"], "hash": _hash_password(new_password)},
        )
        self._session.commit()
        self.record_audit(principal, "ADMIN_CHANGE_PASSWORD", "ADMIN_USER", admin["id"], None)

    # ------------------------------------------------------------ 管理员
    def list_admins(self, principal: AdminPrincipal) -> list[dict]:
        sql = "SELECT * FROM admin_user"
        params: dict = {}
        if not principal.is_super_admin:
            sql += " WHERE org_id = :org_id"
            params["org_id"] = principal.org_id
        rows = self._session.execute(text(sql + " ORDER BY id"), params).mappings()
        return [_admin_view(row) for row in rows]

    def create_admin(self, principal: AdminPrincipal, payload: dict) -> dict:
        if not principal.is_super_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "该操作需要平台超管权限")
        role = payload["role"]
        if role not in ("SUPER_ADMIN", "ORG_ADMIN"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"角色取值非法: {role}")
        if role == "ORG_ADMIN" and payload.get("orgId") is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "组织管理员必须绑定组织")
        exists = self._session.execute(
            text("SELECT count(*) FROM admin_user WHERE username = :username"),
            {"username": payload["username"]},
        ).scalar_one()
        if exists:
            raise ApiError(ErrorCode.PARAM_INVALID, "用户名已存在")
        row = self._session.execute(
            text(
                "INSERT INTO admin_user (username, password_hash, real_name, phone, email, role,"
                " org_id, mfa_enabled, status, failed_login_count)"
                " VALUES (:username, :hash, :real_name, :phone, :email, :role, :org_id, false,"
                " 'ACTIVE', 0) RETURNING *"
            ),
            {
                "username": payload["username"],
                "hash": _hash_password(payload["password"]),
                "real_name": payload.get("realName"),
                "phone": payload.get("phone"),
                "email": payload.get("email"),
                "role": role,
                "org_id": payload.get("orgId") if role == "ORG_ADMIN" else None,
            },
        ).mappings().one()
        self._session.commit()
        self.record_audit(principal, "ADMIN_CREATE", "ADMIN_USER", row["id"], {"role": role})
        return _admin_view(row)

    def update_admin(self, principal: AdminPrincipal, admin_id: int, payload: dict) -> dict:
        if not principal.is_super_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "该操作需要平台超管权限")
        admin = self._require_admin(admin_id)
        if admin["id"] == principal.admin_id and payload.get("status") == "DISABLED":
            raise ApiError(ErrorCode.PARAM_INVALID, "不能停用当前登录的管理员账号")
        row = self._session.execute(
            text(
                "UPDATE admin_user SET real_name = COALESCE(:real_name, real_name),"
                " phone = COALESCE(:phone, phone), email = COALESCE(:email, email),"
                " status = COALESCE(:status, status) WHERE id = :id RETURNING *"
            ),
            {
                "id": admin_id,
                "real_name": payload.get("realName"),
                "phone": payload.get("phone"),
                "email": payload.get("email"),
                "status": payload.get("status"),
            },
        ).mappings().one()
        self._session.commit()
        self.record_audit(principal, "ADMIN_UPDATE", "ADMIN_USER", admin_id, None)
        return _admin_view(row)

    def reset_admin_password(self, principal: AdminPrincipal, admin_id: int, new_password: str) -> None:
        if not principal.is_super_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "该操作需要平台超管权限")
        self._require_admin(admin_id)
        self._session.execute(
            text(
                "UPDATE admin_user SET password_hash = :hash, failed_login_count = 0,"
                " locked_until = NULL WHERE id = :id"
            ),
            {"id": admin_id, "hash": _hash_password(new_password)},
        )
        self._session.commit()
        self.record_audit(principal, "ADMIN_RESET_PASSWORD", "ADMIN_USER", admin_id, None)

    # ---------------------------------------------------------------- 组织
    def list_organizations(self) -> list[dict]:
        rows = self._session.execute(
            text("SELECT * FROM organization WHERE deleted_at IS NULL ORDER BY id DESC")
        ).mappings()
        return [_org_view(row) for row in rows]

    def require_organization(self, org_id: int) -> dict:
        row = self._session.execute(
            text("SELECT * FROM organization WHERE id = :id AND deleted_at IS NULL"), {"id": org_id}
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "组织不存在")
        return dict(row)

    def create_organization(self, principal: AdminPrincipal, payload: dict) -> dict:
        duplicate = self._session.execute(
            text("SELECT count(*) FROM organization WHERE code = :code"), {"code": payload["code"]}
        ).scalar_one()
        if duplicate:
            raise ApiError(ErrorCode.PARAM_INVALID, "组织编码已存在")
        admin_duplicate = self._session.execute(
            text("SELECT count(*) FROM admin_user WHERE username = :username"),
            {"username": payload["adminUsername"]},
        ).scalar_one()
        if admin_duplicate:
            raise ApiError(ErrorCode.PARAM_INVALID, "管理员用户名已存在")
        org = self._session.execute(
            text(
                "INSERT INTO organization (name, code, timezone, max_members, status,"
                " created_by_admin_id)"
                " VALUES (:name, :code, :timezone, :max_members, 'ACTIVE', :admin_id) RETURNING *"
            ),
            {
                "name": payload["name"],
                "code": payload["code"],
                "timezone": payload.get("timezone") or "Asia/Shanghai",
                "max_members": payload.get("maxMembers") or 100,
                "admin_id": principal.admin_id,
            },
        ).mappings().one()
        self._session.execute(
            text(
                "INSERT INTO admin_user (username, password_hash, real_name, role, org_id,"
                " mfa_enabled, status, failed_login_count)"
                " VALUES (:username, :hash, :real_name, 'ORG_ADMIN', :org_id, false, 'ACTIVE', 0)"
            ),
            {
                "username": payload["adminUsername"],
                "hash": _hash_password(payload["adminPassword"]),
                "real_name": payload.get("adminRealName") or payload["adminUsername"],
                "org_id": org["id"],
            },
        )
        self._session.commit()
        self.record_audit(principal, "ORG_CREATE", "ORGANIZATION", org["id"], {"code": payload["code"]})
        return _org_view(org)

    def update_organization(self, principal: AdminPrincipal, org_id: int, payload: dict) -> dict:
        self.require_organization(org_id)
        row = self._session.execute(
            text(
                "UPDATE organization SET name = COALESCE(:name, name),"
                " logo_url = COALESCE(:logo, logo_url),"
                " contact_name = COALESCE(:contact_name, contact_name),"
                " contact_phone = COALESCE(:contact_phone, contact_phone),"
                " timezone = COALESCE(:timezone, timezone),"
                " max_members = COALESCE(:max_members, max_members), updated_at = now()"
                " WHERE id = :id RETURNING *"
            ),
            {
                "id": org_id,
                "name": payload.get("name"),
                "logo": payload.get("logoUrl"),
                "contact_name": payload.get("contactName"),
                "contact_phone": payload.get("contactPhone"),
                "timezone": payload.get("timezone"),
                "max_members": payload.get("maxMembers"),
            },
        ).mappings().one()
        self._session.commit()
        self.record_audit(principal, "ORG_UPDATE", "ORGANIZATION", org_id, None)
        return _org_view(row)

    def change_organization_status(self, principal: AdminPrincipal, org_id: int, status: str) -> dict:
        if status not in ("ACTIVE", "SUSPENDED", "DISABLED"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"状态取值非法: {status}")
        self.require_organization(org_id)
        row = self._session.execute(
            text(
                "UPDATE organization SET status = :status, updated_at = now()"
                " WHERE id = :id RETURNING *"
            ),
            {"id": org_id, "status": status},
        ).mappings().one()
        self._session.commit()
        self.record_audit(principal, "ORG_STATUS_CHANGE", "ORGANIZATION", org_id, {"status": status})
        return _org_view(row)

    def delete_organization(self, principal: AdminPrincipal, org_id: int) -> None:
        self.require_organization(org_id)
        self._session.execute(
            text(
                "UPDATE organization SET deleted_at = now(), status = 'DISABLED' WHERE id = :id"
            ),
            {"id": org_id},
        )
        self._session.commit()
        self.record_audit(principal, "ORG_DELETE", "ORGANIZATION", org_id, None)

    # ---------------------------------------------------------------- 账号
    def search_accounts(self, phone: str | None, status: str | None, limit: int) -> list[dict]:
        rows = self._session.execute(
            text(
                "SELECT * FROM account"
                # 显式 CAST：PG 需要知道 NULL 参数的类型，否则条件里的参数会被判为歧义
                " WHERE (CAST(:phone AS text) IS NULL OR phone LIKE '%' || CAST(:phone AS text) || '%')"
                "   AND (CAST(:status AS text) IS NULL OR status = CAST(:status AS text))"
                " ORDER BY id DESC LIMIT :limit"
            ),
            {"phone": phone or None, "status": status or None, "limit": min(max(limit, 1), 200)},
        ).mappings().all()
        result = []
        for account in rows:
            identities = self._session.execute(
                text(
                    "SELECT i.id, i.identity_type, i.org_id, i.nickname, i.status, o.name AS org_name"
                    " FROM identity i LEFT JOIN organization o ON o.id = i.org_id"
                    " WHERE i.account_id = :account_id ORDER BY i.id"
                ),
                {"account_id": account["id"]},
            ).mappings()
            result.append(
                {
                    "accountId": account["id"],
                    "phone": account["phone"],
                    "email": account["email"],
                    "wechatBound": "BOUND" if account["wechat_unionid"] else None,
                    "status": account["status"],
                    "lastLoginAt": account["last_login_at"],
                    "createdAt": account["created_at"],
                    "identities": [
                        {
                            "identityId": row["id"],
                            "identityType": row["identity_type"],
                            "orgId": row["org_id"],
                            "orgName": row["org_name"],
                            "nickname": row["nickname"],
                            "status": row["status"],
                        }
                        for row in identities
                    ],
                }
            )
        return result

    def change_account_status(self, principal: AdminPrincipal, account_id: int, status: str) -> dict:
        if status not in ("ACTIVE", "DISABLED"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"状态取值非法: {status}")
        row = self._session.execute(
            text("UPDATE account SET status = :status WHERE id = :id RETURNING phone"),
            {"id": account_id, "status": status},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "账号不存在")
        self._session.commit()
        if status == "DISABLED":
            from .auth import AuthService
            from ..wiring import _refresh_store

            for record in _refresh_store().list_for_account(account_id):
                _refresh_store().delete(record.token_id)
        self.record_audit(principal, "ACCOUNT_STATUS_CHANGE", "ACCOUNT", account_id, {"status": status})
        return self.search_accounts(row["phone"], None, 1)[0]

    def change_identity_status(self, principal: AdminPrincipal, identity_id: int, status: str) -> None:
        if status not in ("ACTIVE", "DISABLED"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"状态取值非法: {status}")
        row = self._session.execute(
            text("UPDATE identity SET status = :status WHERE id = :id RETURNING account_id"),
            {"id": identity_id, "status": status},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.IDENTITY_UNAVAILABLE)
        self._session.commit()
        self.record_audit(principal, "IDENTITY_STATUS_CHANGE", "IDENTITY", identity_id, {"status": status})

    def force_logout(self, principal: AdminPrincipal, account_id: int) -> None:
        from ..wiring import _refresh_store

        for record in _refresh_store().list_for_account(account_id):
            _refresh_store().delete(record.token_id)
        self.record_audit(principal, "ACCOUNT_FORCE_LOGOUT", "ACCOUNT", account_id, None)

    # ------------------------------------------------------------ 配置看板
    def list_configs(self) -> list[dict]:
        rows = self._session.execute(
            text("SELECT * FROM system_config ORDER BY config_key")
        ).mappings()
        return [
            {
                "configKey": row["config_key"],
                "configValue": json.dumps(row["config_value"], ensure_ascii=False)
                if row["config_value"] is not None
                else None,
                "description": row["description"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def update_config(self, principal: AdminPrincipal, key: str, config_value: str, description: str | None) -> dict:
        try:
            parsed = json.loads(config_value)
        except json.JSONDecodeError as exc:
            raise ApiError(ErrorCode.PARAM_INVALID, "配置值必须是合法 JSON") from exc
        row = self._session.execute(
            text(
                "INSERT INTO system_config (config_key, config_value, description,"
                " updated_by_admin_id, updated_at)"
                " VALUES (:key, :value, :description, :admin_id, now())"
                " ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value,"
                " description = COALESCE(EXCLUDED.description, system_config.description),"
                " updated_by_admin_id = EXCLUDED.updated_by_admin_id, updated_at = now()"
                " RETURNING *"
            ),
            {
                "key": key,
                "value": json.dumps(parsed, ensure_ascii=False),
                "description": description,
                "admin_id": principal.admin_id,
            },
        ).mappings().one()
        self._session.commit()
        self.record_audit(principal, "SYSTEM_CONFIG_UPDATE", "SYSTEM_CONFIG", row["id"], {"key": key})
        return {
            "configKey": row["config_key"],
            "configValue": row["config_value"],
            "description": row["description"],
            "updatedAt": row["updated_at"],
        }

    def dashboard_stats(self) -> dict:
        scalar = lambda sql, params=None: self._session.execute(text(sql), params or {}).scalar_one()  # noqa: E731
        return {
            "organizationCount": scalar(
                "SELECT count(*) FROM organization WHERE deleted_at IS NULL"
            ),
            "activeOrganizationCount": scalar(
                "SELECT count(*) FROM organization WHERE deleted_at IS NULL AND status = 'ACTIVE'"
            ),
            "accountCount": scalar("SELECT count(*) FROM account"),
            "disabledAccountCount": scalar(
                "SELECT count(*) FROM account WHERE status = 'DISABLED'"
            ),
            "orgMemberCount": scalar(
                "SELECT count(*) FROM org_member WHERE status = 'ACTIVE'"
            ),
            "personalEventCount": scalar(
                "SELECT count(*) FROM event WHERE deleted_at IS NULL AND source_type = 'PERSONAL'"
            ),
            "taskCount": scalar("SELECT count(*) FROM task WHERE deleted_at IS NULL"),
            "completedTaskCount": scalar(
                "SELECT count(*) FROM task WHERE deleted_at IS NULL AND status = 'DONE'"
            ),
            "dispatchCount": scalar("SELECT count(*) FROM event_dispatch"),
        }

    # ---------------------------------------------------------------- 审计
    def search_audit_logs(
        self,
        action: str | None,
        actor_name: str | None,
        org_id: int | None,
        limit: int,
    ) -> list[dict]:
        rows = self._session.execute(
            text(
                "SELECT * FROM audit_log"
                " WHERE (CAST(:action AS text) IS NULL OR action = CAST(:action AS text))"
                "   AND (CAST(:actor_name AS text) IS NULL"
                "        OR actor_name LIKE '%' || CAST(:actor_name AS text) || '%')"
                "   AND (CAST(:org_id AS bigint) IS NULL OR org_id = CAST(:org_id AS bigint))"
                " ORDER BY id DESC LIMIT :limit"
            ),
            {
                "action": action or None,
                "actor_name": actor_name or None,
                "org_id": org_id,
                "limit": min(max(limit, 1), 500),
            },
        ).mappings()
        return [
            {
                "id": row["id"],
                "actorType": row["actor_type"],
                "actorName": row["actor_name"],
                "orgId": row["org_id"],
                "action": row["action"],
                "targetType": row["target_type"],
                "targetId": row["target_id"],
                "detail": json.dumps(row["detail"], ensure_ascii=False)
                if row["detail"] is not None
                else None,
                "ip": row["ip"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def export_audit_logs(self, action: str | None, actor_name: str | None, limit: int) -> str:
        header = "时间,操作人,角色,动作,对象类型,对象ID,详情,IP"
        lines = [header]
        for row in self.search_audit_logs(action, actor_name, None, limit):
            lines.append(
                ",".join(
                    _csv(value)
                    for value in (
                        row["createdAt"],
                        row["actorName"],
                        row["actorType"],
                        row["action"],
                        row["targetType"],
                        row["targetId"],
                        row["detail"],
                        row["ip"],
                    )
                )
            )
        return "\n".join(lines) + "\n"

    def record_audit(
        self,
        principal: AdminPrincipal,
        action: str,
        target_type: str,
        target_id: int | None,
        detail,
    ) -> None:
        try:
            self._session.execute(
                text(
                    "INSERT INTO audit_log (actor_type, actor_id, actor_name, action, target_type,"
                    " target_id, detail) VALUES ('ADMIN', :actor_id, :actor_name, :action,"
                    " :target_type, :target_id, :detail)"
                ),
                {
                    "actor_id": principal.admin_id,
                    "actor_name": principal.username,
                    "action": action,
                    "target_type": target_type,
                    "target_id": target_id,
                    "detail": json.dumps(detail, ensure_ascii=False) if detail else None,
                },
            )
            self._session.commit()
        except Exception:  # noqa: BLE001 - 审计写入失败不影响主流程
            self._session.rollback()

    def _record_login(
        self, admin_id: int | None, result: str, fail_reason: str | None, ip: str | None, user_agent: str | None
    ) -> None:
        try:
            self._session.execute(
                text(
                    "INSERT INTO login_log (principal_type, admin_user_id, login_type, result,"
                    " fail_reason, ip, user_agent) VALUES ('ADMIN', :admin_id, 'PASSWORD', :result,"
                    " :reason, :ip, :user_agent)"
                ),
                {
                    "admin_id": admin_id,
                    "result": result,
                    "reason": fail_reason,
                    "ip": ip,
                    "user_agent": user_agent,
                },
            )
            self._session.commit()
        except Exception:  # noqa: BLE001
            self._session.rollback()

    def _require_admin(self, admin_id: int) -> dict:
        row = self._session.execute(
            text("SELECT * FROM admin_user WHERE id = :id"), {"id": admin_id}
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED, http_status=401)
        return dict(row)


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()


def _admin_view(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "realName": row["real_name"],
        "role": row["role"],
        "orgId": row["org_id"],
        "status": row["status"],
    }


def _org_view(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "code": row["code"],
        "logoUrl": row["logo_url"],
        "timezone": row["timezone"],
        "status": row["status"],
        "maxMembers": row["max_members"],
        "createdAt": row["created_at"],
    }


def _csv(value) -> str:
    text_value = "" if value is None else str(value)
    return '"' + text_value.replace('"', '""') + '"'
