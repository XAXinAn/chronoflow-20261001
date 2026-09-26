from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity, current_org_actor
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.org import OrgService
from ..wiring import get_refresh_store

router = APIRouter(prefix="/api/v1", tags=["org"])


class DepartmentCreate(BaseModel):
    parentId: int | None = None
    name: str
    sortOrder: int | None = None


class DepartmentUpdate(BaseModel):
    name: str | None = None
    sortOrder: int | None = None


class ManagerGrant(BaseModel):
    orgMemberId: int


class MemberCreate(BaseModel):
    """新增成员：**只需要成员唯一识别 ID**（spec §3.1）；手机号、密码都不需要。"""

    memberKey: str
    realName: str
    departmentId: int
    jobTitle: str | None = None
    orgRole: str | None = None


class MemberUpdate(BaseModel):
    realName: str | None = None
    departmentId: int | None = None
    memberKey: str | None = None
    jobTitle: str | None = None
    orgRole: str | None = None
    status: str | None = None


class DispatchRequest(BaseModel):
    title: str
    description: str | None = None
    location: str | None = None
    startAt: datetime
    endAt: datetime
    allDay: bool | None = None
    timezone: str | None = None
    rrule: str | None = None
    scopeType: str
    departmentId: int | None = None
    includeSubDepartments: bool | None = None
    memberIds: list[int] | None = None


class OrgEventUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    location: str | None = None
    startAt: datetime | None = None
    endAt: datetime | None = None
    allDay: bool | None = None
    timezone: str | None = None
    redispatch: bool | None = None


class OrgSettingsUpdate(BaseModel):
    """组织设置（spec §4.3）。没有 maxMembers：成员上限只读，由平台超管控制。"""

    name: str | None = None
    logoUrl: str | None = None
    contactName: str | None = None
    contactPhone: str | None = None
    timezone: str | None = None


def _service(session: Session = Depends(get_session)) -> OrgService:
    # 注入刷新令牌存储：解绑组织账号时要吊销该身份的会话（spec §3.2）
    return OrgService(session, get_refresh_store())


def _member(principal: IdentityPrincipal, service: OrgService) -> dict:
    return service.require_membership(principal)


def _actor(principal, service: OrgService) -> dict:
    """组织管理端的执行者：App 组织身份，或后台组织管理员（spec §3.2 / §4.3）。"""
    return service.resolve_actor(principal)


@router.get("/org/current")
def org_current(
    principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    return envelope(service.current_context(_member(principal, service)))


@router.get("/org/departments/tree")
def org_department_tree(
    principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    return envelope(service.department_tree(member["org_id"]))


@router.get("/org/members")
def org_members(
    departmentId: int | None = None,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.list_members(member, departmentId))


@router.get("/org/events")
def org_events(
    start: datetime = Query(...),
    end: datetime = Query(...),
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.list_org_events(member, start, end))


@router.post("/org/events/{id}/read")
def org_event_read(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    service.mark_read(member, id)
    return envelope(None)


@router.get("/org-admin/departments")
def admin_department_tree(principal=Depends(current_org_actor), service=Depends(_service)) -> dict:
    """组织管理端的部门树（spec §6.3）。"""
    actor = _actor(principal, service)
    return envelope(service.department_tree(actor["org_id"]))


@router.post("/org-admin/departments")
def create_department(
    payload: DepartmentCreate,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    created = service.create_department(actor, payload.model_dump())
    service.record_org_audit(actor, "ORG_DEPARTMENT_CREATE", "DEPARTMENT", created["id"],
                             {"name": created["name"]})
    return envelope(created)


@router.patch("/org-admin/departments/{id}")
def update_department(
    id: int,
    payload: DepartmentUpdate,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    updated = service.update_department(actor, id, payload.model_dump())
    service.record_org_audit(actor, "ORG_DEPARTMENT_UPDATE", "DEPARTMENT", id)
    return envelope(updated)


@router.delete("/org-admin/departments/{id}")
def delete_department(
    id: int, principal=Depends(current_org_actor), service=Depends(_service)
) -> dict:
    actor = _actor(principal, service)
    service.delete_department(actor, id)
    service.record_org_audit(actor, "ORG_DEPARTMENT_DELETE", "DEPARTMENT", id)
    return envelope(None)


@router.post("/org-admin/departments/{id}/managers")
def grant_manager(
    id: int,
    payload: ManagerGrant,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    service.grant_manager(actor, id, payload.orgMemberId)
    service.record_org_audit(actor, "ORG_DEPARTMENT_MANAGER_GRANT", "DEPARTMENT", id,
                             {"orgMemberId": payload.orgMemberId})
    return envelope(None)


@router.delete("/org-admin/departments/{id}/managers/{orgMemberId}")
def revoke_manager(
    id: int,
    orgMemberId: int,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    service.revoke_manager(actor, id, orgMemberId)
    service.record_org_audit(actor, "ORG_DEPARTMENT_MANAGER_REVOKE", "DEPARTMENT", id,
                             {"orgMemberId": orgMemberId})
    return envelope(None)


@router.get("/org-admin/members")
def admin_members(principal=Depends(current_org_actor), service=Depends(_service)) -> dict:
    actor = _actor(principal, service)
    return envelope(service.list_members(actor, None))


@router.post("/org-admin/members")
def admin_create_member(
    payload: MemberCreate,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    created = service.create_member(actor, payload.model_dump())
    service.record_org_audit(actor, "ORG_MEMBER_CREATE", "ORG_MEMBER", created["id"],
                             {"memberKey": created["memberKey"],
                              "departmentId": created["departmentId"]})
    return envelope(created)


@router.patch("/org-admin/members/{id}")
def admin_update_member(
    id: int,
    payload: MemberUpdate,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    updated = service.update_member(actor, id, payload.model_dump())
    service.record_org_audit(actor, "ORG_MEMBER_UPDATE", "ORG_MEMBER", id)
    return envelope(updated)


@router.post("/org-admin/members/{id}/unbind")
def admin_unbind_member(
    id: int,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    """解绑成员的组织账号（spec §3.2 / §6.3）：成员换号或被冒领后的恢复路径。"""
    actor = _actor(principal, service)
    unbound = service.unbind_member(actor, id)
    service.record_org_audit(actor, "ORG_MEMBER_UNBIND", "ORG_MEMBER", id)
    return envelope(unbound)


@router.post("/org-admin/members/import")
async def import_members(
    file: UploadFile = File(...),
    autoCreateDepartment: bool = Query(default=False),
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    content = await file.read()
    detail = service.import_members(
        actor, file.filename or "import", content, autoCreateDepartment
    )
    service.record_org_audit(actor, "ORG_MEMBER_IMPORT", "IMPORT_BATCH",
                             detail["batchId"], {"fileName": detail["fileName"]})
    return envelope(detail)


@router.get("/org-admin/members/import/template")
def import_template(principal=Depends(current_org_actor), service=Depends(_service)) -> Response:
    _actor(principal, service)
    return Response(
        content=service.import_template(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="member-import-template.xlsx"'},
    )


@router.get("/org-admin/imports")
def list_imports(principal=Depends(current_org_actor), service=Depends(_service)) -> dict:
    actor = _actor(principal, service)
    return envelope(service.list_imports(actor))


@router.get("/org-admin/imports/{id}")
def import_detail(
    id: int, principal=Depends(current_org_actor), service=Depends(_service)
) -> dict:
    actor = _actor(principal, service)
    return envelope(service.import_detail(actor, id))


@router.get("/org-admin/imports/{id}/failures")
def import_failures(
    id: int, principal=Depends(current_org_actor), service=Depends(_service)
) -> Response:
    """失败明细 CSV，便于修正后重传（spec §6.3）。"""
    actor = _actor(principal, service)
    return Response(
        content=service.import_failures_csv(actor, id),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="import-failures-{id}.csv"'},
    )


@router.get("/org-admin/events")
def admin_events(
    start: datetime = Query(...),
    end: datetime = Query(...),
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    """组织管理端的组织日程列表（spec §6.3）：本组织的活跃下发 + 回执分布。"""
    actor = _actor(principal, service)
    return envelope(service.admin_event_list(actor, start, end))


@router.post("/org-admin/events")
def dispatch_event(
    payload: DispatchRequest,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    created = service.dispatch(actor, payload.model_dump())
    service.record_org_audit(actor, "ORG_EVENT_DISPATCH", "EVENT", created["eventId"],
                             {"scopeType": payload.scopeType,
                              "dispatchId": created["dispatchId"]})
    return envelope(created)


@router.patch("/org-admin/events/{id}")
def update_org_event(
    id: int,
    payload: OrgEventUpdate,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    updated = service.update_org_event(actor, id, payload.model_dump())
    service.record_org_audit(actor, "ORG_EVENT_UPDATE", "EVENT", id)
    return envelope(updated)


@router.delete("/org-admin/events/{id}")
def delete_org_event(
    id: int, principal=Depends(current_org_actor), service=Depends(_service)
) -> dict:
    actor = _actor(principal, service)
    service.delete_org_event(actor, id)
    service.record_org_audit(actor, "ORG_EVENT_DELETE", "EVENT", id)
    return envelope(None)


@router.post("/org-admin/events/{id}/revoke")
def revoke_dispatch(
    id: int, principal=Depends(current_org_actor), service=Depends(_service)
) -> dict:
    actor = _actor(principal, service)
    service.revoke_dispatch(actor, id)
    service.record_org_audit(actor, "ORG_EVENT_REVOKE", "EVENT", id)
    return envelope(None)


@router.get("/org-admin/settings")
def org_settings(principal=Depends(current_org_actor), service=Depends(_service)) -> dict:
    actor = _actor(principal, service)
    return envelope(service.org_settings(actor))


@router.patch("/org-admin/settings")
def update_org_settings(
    payload: OrgSettingsUpdate,
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    actor = _actor(principal, service)
    updated = service.update_org_settings(actor, payload.model_dump())
    service.record_org_audit(actor, "ORG_SETTINGS_UPDATE", "ORGANIZATION", actor["org_id"])
    return envelope(updated)


@router.get("/org-admin/logs")
def org_audit_logs(
    action: str | None = None,
    limit: int = Query(default=100),
    principal=Depends(current_org_actor),
    service=Depends(_service),
) -> dict:
    """本组织的操作日志（spec §6.3）。只服务后台组织管理员。"""
    actor = _actor(principal, service)
    return envelope(service.audit_logs(actor, action, limit))
