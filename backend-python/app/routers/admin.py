from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_admin, current_super_admin
from ..errors import envelope
from ..security import AdminPrincipal
from ..services.admin import AdminService

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


class AdminLogin(BaseModel):
    username: str
    password: str


class AdminCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=64)
    realName: str | None = None
    phone: str | None = None
    email: str | None = None
    role: str
    orgId: int | None = None


class AdminUpdate(BaseModel):
    realName: str | None = None
    phone: str | None = None
    email: str | None = None
    status: str | None = None


class ChangePassword(BaseModel):
    oldPassword: str
    newPassword: str = Field(min_length=8, max_length=64)


class ResetPassword(BaseModel):
    newPassword: str = Field(min_length=8, max_length=64)


class OrganizationCreate(BaseModel):
    name: str
    code: str
    timezone: str | None = None
    maxMembers: int | None = None
    adminUsername: str = Field(min_length=3, max_length=64)
    adminPassword: str = Field(min_length=8, max_length=64)
    adminRealName: str | None = None


class OrganizationUpdate(BaseModel):
    name: str | None = None
    logoUrl: str | None = None
    contactName: str | None = None
    contactPhone: str | None = None
    timezone: str | None = None
    maxMembers: int | None = None


class StatusRequest(BaseModel):
    status: str


class ConfigUpdate(BaseModel):
    configValue: str
    description: str | None = None


def _service(session: Session = Depends(get_session)) -> AdminService:
    return AdminService(session)


@router.post("/auth/login")
def login(
    payload: AdminLogin, request: Request, service: AdminService = Depends(_service)
) -> dict:
    forwarded = request.headers.get("x-forwarded-for")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else None)
    return envelope(service.login(payload.username, payload.password, ip, request.headers.get("user-agent")))


@router.get("/me")
def me(principal: AdminPrincipal = Depends(current_admin), service: AdminService = Depends(_service)) -> dict:
    return envelope(service.me(principal))


@router.put("/me/password")
def change_password(
    payload: ChangePassword,
    principal: AdminPrincipal = Depends(current_admin),
    service: AdminService = Depends(_service),
) -> dict:
    service.change_password(principal, payload.oldPassword, payload.newPassword)
    return envelope(None)


@router.get("/admins")
def list_admins(
    principal: AdminPrincipal = Depends(current_admin), service: AdminService = Depends(_service)
) -> dict:
    return envelope(service.list_admins(principal))


@router.post("/admins")
def create_admin(
    payload: AdminCreate,
    principal: AdminPrincipal = Depends(current_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.create_admin(principal, payload.model_dump()))


@router.patch("/admins/{id}")
def update_admin(
    id: int,
    payload: AdminUpdate,
    principal: AdminPrincipal = Depends(current_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.update_admin(principal, id, payload.model_dump()))


@router.post("/admins/{id}/reset-password")
def reset_password(
    id: int,
    payload: ResetPassword,
    principal: AdminPrincipal = Depends(current_admin),
    service: AdminService = Depends(_service),
) -> dict:
    service.reset_admin_password(principal, id, payload.newPassword)
    return envelope(None)


@router.get("/organizations")
def list_organizations(
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.list_organizations())


@router.post("/organizations")
def create_organization(
    payload: OrganizationCreate,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.create_organization(principal, payload.model_dump()))


@router.get("/organizations/{id}")
def get_organization(
    id: int,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    from ..services.admin import _org_view

    return envelope(_org_view(service.require_organization(id)))


@router.patch("/organizations/{id}")
def update_organization(
    id: int,
    payload: OrganizationUpdate,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.update_organization(principal, id, payload.model_dump()))


@router.post("/organizations/{id}/status")
def change_organization_status(
    id: int,
    payload: StatusRequest,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.change_organization_status(principal, id, payload.status))


@router.delete("/organizations/{id}")
def delete_organization(
    id: int,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    service.delete_organization(principal, id)
    return envelope(None)


@router.get("/accounts")
def search_accounts(
    phone: str | None = None,
    status: str | None = None,
    limit: int = 50,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.search_accounts(phone, status, limit))


@router.post("/accounts/{id}/status")
def change_account_status(
    id: int,
    payload: StatusRequest,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.change_account_status(principal, id, payload.status))


@router.post("/identities/{id}/status")
def change_identity_status(
    id: int,
    payload: StatusRequest,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    service.change_identity_status(principal, id, payload.status)
    return envelope(None)


@router.post("/accounts/{id}/force-logout")
def force_logout(
    id: int,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    service.force_logout(principal, id)
    return envelope(None)


@router.get("/configs")
def list_configs(
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.list_configs())


@router.put("/configs/{key}")
def update_config(
    key: str,
    payload: ConfigUpdate,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.update_config(principal, key, payload.configValue, payload.description))


@router.get("/dashboard/stats")
def dashboard_stats(
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.dashboard_stats())


@router.get("/audit-logs")
def audit_logs(
    action: str | None = None,
    actorName: str | None = None,
    orgId: int | None = None,
    limit: int = 100,
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> dict:
    return envelope(service.search_audit_logs(action, actorName, orgId, limit))


@router.get("/audit-logs/export")
def export_audit_logs(
    action: str | None = Query(default=None),
    actorName: str | None = Query(default=None),
    limit: int = Query(default=500),
    principal: AdminPrincipal = Depends(current_super_admin),
    service: AdminService = Depends(_service),
) -> Response:
    return Response(
        content=service.export_audit_logs(action, actorName, limit),
        media_type="text/csv;charset=UTF-8",
        headers={"Content-Disposition": 'attachment; filename="audit-logs.csv"'},
    )
