from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.org import OrgService

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
    phone: str
    realName: str
    departmentId: int
    memberNo: str | None = None
    jobTitle: str | None = None
    orgRole: str | None = None


class MemberUpdate(BaseModel):
    realName: str | None = None
    departmentId: int | None = None
    memberNo: str | None = None
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
    requireReceipt: bool | None = None


class OrgEventUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    location: str | None = None
    startAt: datetime | None = None
    endAt: datetime | None = None
    allDay: bool | None = None
    timezone: str | None = None
    redispatch: bool | None = None


class ReceiptRequest(BaseModel):
    status: str
    remark: str | None = None
    occurrenceDate: str | None = None


def _service(session: Session = Depends(get_session)) -> OrgService:
    return OrgService(session)


def _member(principal: IdentityPrincipal, service: OrgService) -> dict:
    return service.require_membership(principal)


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


@router.post("/org/events/{id}/receipt")
def org_event_receipt(
    id: int,
    payload: ReceiptRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.submit_receipt(member, id, payload.status, payload.remark))


@router.post("/org/events/{id}/read")
def org_event_read(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    service.mark_read(member, id)
    return envelope(None)


@router.get("/org/events/{id}/recipients")
def org_event_recipients(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    return envelope(service.receipt_summary(member, id))


@router.post("/org-admin/departments")
def create_department(
    payload: DepartmentCreate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.create_department(member, payload.model_dump()))


@router.patch("/org-admin/departments/{id}")
def update_department(
    id: int,
    payload: DepartmentUpdate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.update_department(member, id, payload.model_dump()))


@router.delete("/org-admin/departments/{id}")
def delete_department(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    service.delete_department(member, id)
    return envelope(None)


@router.post("/org-admin/departments/{id}/managers")
def grant_manager(
    id: int,
    payload: ManagerGrant,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    service.grant_manager(member, id, payload.orgMemberId)
    return envelope(None)


@router.delete("/org-admin/departments/{id}/managers/{orgMemberId}")
def revoke_manager(
    id: int,
    orgMemberId: int,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    service.revoke_manager(member, id, orgMemberId)
    return envelope(None)


@router.get("/org-admin/members")
def admin_members(
    principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    return envelope(service.list_members(member, None))


@router.post("/org-admin/members")
def admin_create_member(
    payload: MemberCreate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.create_member(member, payload.model_dump()))


@router.patch("/org-admin/members/{id}")
def admin_update_member(
    id: int,
    payload: MemberUpdate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.update_member(member, id, payload.model_dump()))


@router.post("/org-admin/members/import")
async def import_members(
    file: UploadFile = File(...),
    autoCreateDepartment: bool = Query(default=False),
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    content = await file.read()
    return envelope(
        service.import_members(member, file.filename or "import", content, autoCreateDepartment)
    )


@router.get("/org-admin/members/import/template")
def import_template(
    principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> Response:
    _member(principal, service)
    return Response(
        content=service.import_template(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="member-import-template.xlsx"'},
    )


@router.get("/org-admin/imports")
def list_imports(
    principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    return envelope(service.list_imports(member))


@router.get("/org-admin/imports/{id}")
def import_detail(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    return envelope(service.import_detail(member, id))


@router.post("/org-admin/events")
def dispatch_event(
    payload: DispatchRequest,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.dispatch(member, payload.model_dump()))


@router.patch("/org-admin/events/{id}")
def update_org_event(
    id: int,
    payload: OrgEventUpdate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    member = _member(principal, service)
    return envelope(service.update_org_event(member, id, payload.model_dump()))


@router.delete("/org-admin/events/{id}")
def delete_org_event(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    service.delete_org_event(member, id)
    return envelope(None)


@router.post("/org-admin/events/{id}/revoke")
def revoke_dispatch(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    service.revoke_dispatch(member, id)
    return envelope(None)


@router.get("/org-admin/events/{id}/receipts")
def org_event_receipts(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    member = _member(principal, service)
    return envelope(service.receipt_summary(member, id))
