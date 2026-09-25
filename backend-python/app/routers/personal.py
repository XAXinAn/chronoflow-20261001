from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.personal import PersonalService

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
    location: str | None = None
    startAt: datetime
    endAt: datetime
    allDay: bool | None = None
    timezone: str | None = None
    rrule: str | None = None


class EventUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    location: str | None = None
    startAt: datetime | None = None
    endAt: datetime | None = None
    allDay: bool | None = None
    timezone: str | None = None
    rrule: str | None = None
    scope: str | None = None
    occurrenceDate: str | None = None


class TaskCreate(BaseModel):
    calendarId: int | None = None
    parentTaskId: int | None = None
    title: str
    description: str | None = None
    dueAt: datetime | None = None
    allDay: bool | None = None
    priority: str | None = None
    rrule: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    dueAt: datetime | None = None
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
