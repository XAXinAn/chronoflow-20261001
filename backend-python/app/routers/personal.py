from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.holiday import HolidayService
from ..services.personal import PersonalService
from ..services.search import SearchService

router = APIRouter(prefix="/api/v1", tags=["personal"])


class CalendarCreate(BaseModel):
    name: str
    color: str | None = None
    timezone: str | None = None
    isDefault: bool | None = None


class CalendarUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    timezone: str | None = None
    isDefault: bool | None = None


class EventCreate(BaseModel):
    calendarId: int | None = None
    title: str
    description: str | None = None
    # 结构化地点（spec §5.9）。坐标系不接受客户端指定，服务端统一按 GCJ-02 落库。
    locationName: str | None = Field(default=None, max_length=128)
    locationAddress: str | None = Field(default=None, max_length=255)
    latitude: float | None = None
    longitude: float | None = None
    poiId: str | None = Field(default=None, max_length=64)
    startAt: datetime
    endAt: datetime
    allDay: bool | None = None
    timezone: str | None = None
    rrule: str | None = None
    status: str | None = None
    availability: str | None = None
    color: str | None = None
    priority: str | None = None
    category: str | None = None
    url: str | None = None
    travelTimeMinutes: int | None = None


class EventUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    locationName: str | None = None
    locationAddress: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    poiId: str | None = None
    startAt: datetime | None = None
    endAt: datetime | None = None
    allDay: bool | None = None
    timezone: str | None = None
    rrule: str | None = None
    status: str | None = None
    availability: str | None = None
    color: str | None = None
    priority: str | None = None
    category: str | None = None
    url: str | None = None
    travelTimeMinutes: int | None = None
    scope: str | None = None
    occurrenceDate: str | None = None


class TaskCreate(BaseModel):
    calendarId: int | None = None
    parentTaskId: int | None = None
    # 关联的日程 id，可空（spec §4.1.6）
    eventId: int | None = None
    title: str
    description: str | None = None
    dueAt: datetime | None = None
    allDay: bool | None = None
    priority: str | None = None
    rrule: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    eventId: int | None = None
    # 显式解除日程关联：null 在 PATCH 里是「不修改」
    clearEvent: bool | None = None
    dueAt: datetime | None = None
    # 显式清空截止时间（回到「待安排」）。null 在 PATCH 里表示「不修改」，
    # 只靠 dueAt=null 的话，用户一旦设过截止时间就再也去不掉了。
    clearDueAt: bool | None = None
    allDay: bool | None = None
    priority: str | None = None
    status: str | None = None
    sortOrder: int | None = None


class TaskComplete(BaseModel):
    completed: bool


class TaskToEvent(BaseModel):
    startAt: datetime | None = None
    endAt: datetime | None = None


class ReminderItem(BaseModel):
    minutesBefore: int = Field(ge=0)
    occurrenceDate: str | None = None


class SetReminders(BaseModel):
    targetType: str
    targetId: int
    items: list[ReminderItem]


def _service(session: Session = Depends(get_session)) -> PersonalService:
    return PersonalService(session)


@router.get("/calendars")
def list_calendars(
    principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    return envelope(service.list_calendars(principal.identity_id))


@router.post("/calendars")
def create_calendar(
    payload: CalendarCreate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.create_calendar(principal.identity_id, payload.model_dump()))


@router.get("/calendars/{id}")
def get_calendar(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    calendar = service.require_calendar(principal.identity_id, id)
    return envelope(
        {
            "id": calendar["id"],
            "calendarType": calendar["calendar_type"],
            "name": calendar["name"],
            "color": calendar["color"],
            "timezone": calendar["timezone"],
            "isDefault": bool(calendar["is_default"]),
        }
    )


@router.patch("/calendars/{id}")
def update_calendar(
    id: int,
    payload: CalendarUpdate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.update_calendar(principal.identity_id, id, payload.model_dump()))


@router.delete("/calendars/{id}")
def delete_calendar(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    service.disable_calendar(principal.identity_id, id)
    return envelope(None)


@router.get("/events")
def list_events(
    start: datetime = Query(...),
    end: datetime = Query(...),
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.list_events(principal.identity_id, None, start, end))


@router.post("/events")
def create_event(
    payload: EventCreate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.create_event(principal.identity_id, payload.model_dump()))


@router.get("/events/{id}")
def get_event(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    from ..services.personal import _event_view

    return envelope(_event_view(service.require_event(principal.identity_id, id)))


@router.patch("/events/{id}")
def update_event(
    id: int,
    payload: EventUpdate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.update_event(principal.identity_id, id, payload.model_dump()))


@router.delete("/events/{id}")
def delete_event(
    id: int,
    scope: str | None = None,
    occurrenceDate: str | None = None,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    service.delete_event(principal.identity_id, id, scope, occurrenceDate)
    return envelope(None)


@router.post("/events/{id}/convert-to-task")
def convert_event_to_task(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    return envelope(service.convert_event_to_task(principal.identity_id, id))


@router.get("/tasks")
def list_tasks(
    status: str | None = None,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.list_tasks(principal.identity_id, status))


@router.post("/tasks")
def create_task(
    payload: TaskCreate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.create_task(principal.identity_id, payload.model_dump()))


@router.get("/tasks/{id}")
def get_task(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    from ..services.personal import _task_view

    return envelope(_task_view(service.require_task(principal.identity_id, id)))


@router.patch("/tasks/{id}")
def update_task(
    id: int,
    payload: TaskUpdate,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.update_task(principal.identity_id, id, payload.model_dump()))


@router.delete("/tasks/{id}")
def delete_task(
    id: int, principal: IdentityPrincipal = Depends(current_identity), service=Depends(_service)
) -> dict:
    service.delete_task(principal.identity_id, id)
    return envelope(None)


@router.post("/tasks/{id}/complete")
def complete_task(
    id: int,
    payload: TaskComplete,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.complete_task(principal.identity_id, id, payload.completed))


@router.post("/tasks/{id}/convert-to-event")
def convert_task_to_event(
    id: int,
    payload: TaskToEvent | None = Body(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(
        service.convert_task_to_event(
            principal.identity_id, id, payload.model_dump() if payload else {}
        )
    )


@router.put("/reminders")
def set_reminders(
    payload: SetReminders,
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    items = [item.model_dump() for item in payload.items]
    return envelope(
        service.set_reminders(principal.identity_id, payload.targetType, payload.targetId, items)
    )


@router.get("/reminders")
def list_reminders(
    targetType: str = Query(...),
    targetId: int = Query(...),
    principal: IdentityPrincipal = Depends(current_identity),
    service=Depends(_service),
) -> dict:
    return envelope(service.list_reminders(principal.identity_id, targetType, targetId))


@router.get("/search")
def search(
    keyword: str = Query(...),
    types: list[str] | None = Query(default=None),
    limit: int | None = Query(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    """跨日程与待办的关键字检索，不受当前月份限制（spec §4.1.7）。"""
    return envelope(SearchService(session).search(principal.identity_id, keyword, types, limit))


@router.get("/holidays")
def holidays(
    year: int = Query(...),
    month: int | None = Query(default=None),
    country: str | None = Query(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    """节假日与调休；省略 month 返回全年（spec §5.11）。"""
    return envelope(HolidayService(session).query(country, year, month))
