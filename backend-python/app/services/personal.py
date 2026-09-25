"""个人日历、日程、待办与提醒（spec §4.1）。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from . import recurrence

DEFAULT_CALENDAR_NAME = "我的日程"


class PersonalService:
    def __init__(self, session: Session):
        self._session = session

    # ---------------------------------------------------------------- 日历
    def list_calendars(self, identity_id: int) -> list[dict]:
        self._ensure_default_calendar(identity_id)
        rows = self._session.execute(
            text(
                "SELECT id, calendar_type, name, color, timezone, is_default FROM calendar"
                " WHERE owner_identity_id = :identity AND status = 'ACTIVE'"
                " ORDER BY is_default DESC, id"
            ),
            {"identity": identity_id},
        ).mappings()
        return [_calendar_view(row) for row in rows]

    def _ensure_default_calendar(self, identity_id: int) -> None:
        count = self._session.execute(
            text(
                "SELECT count(*) FROM calendar"
                " WHERE owner_identity_id = :identity AND status = 'ACTIVE'"
            ),
            {"identity": identity_id},
        ).scalar_one()
        if count:
            return
        self._session.execute(
            text(
                "INSERT INTO calendar"
                " (calendar_type, owner_identity_id, name, color, timezone, is_default, status)"
                " VALUES ('PERSONAL', :identity, :name, '#0A0A0A', 'Asia/Shanghai', true, 'ACTIVE')"
            ),
            {"identity": identity_id, "name": DEFAULT_CALENDAR_NAME},
        )
        self._session.commit()

    def default_calendar_id(self, identity_id: int) -> int:
        self._ensure_default_calendar(identity_id)
        return self._session.execute(
            text(
                "SELECT id FROM calendar WHERE owner_identity_id = :identity AND status = 'ACTIVE'"
                " ORDER BY is_default DESC, id LIMIT 1"
            ),
            {"identity": identity_id},
        ).scalar_one()

    def require_calendar(self, identity_id: int, calendar_id: int) -> dict:
        row = self._session.execute(
            text(
                "SELECT * FROM calendar WHERE id = :id AND calendar_type = 'PERSONAL'"
                " AND owner_identity_id = :identity AND status <> 'DISABLED'"
            ),
            {"id": calendar_id, "identity": identity_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "日历不存在或不属于当前身份")
        return dict(row)

    def create_calendar(self, identity_id: int, payload: dict) -> dict:
        if payload.get("isDefault"):
            self._clear_default(identity_id)
        row = self._session.execute(
            text(
                "INSERT INTO calendar"
                " (calendar_type, owner_identity_id, name, color, timezone, is_default, status)"
                " VALUES ('PERSONAL', :identity, :name, :color, :timezone, :is_default, 'ACTIVE')"
                " RETURNING id, calendar_type, name, color, timezone, is_default"
            ),
            {
                "identity": identity_id,
                "name": payload["name"],
                "color": payload.get("color") or "#0A0A0A",
                "timezone": payload.get("timezone") or "Asia/Shanghai",
                "is_default": bool(payload.get("isDefault")),
            },
        ).mappings().one()
        self._session.commit()
        return _calendar_view(row)

    def update_calendar(self, identity_id: int, calendar_id: int, payload: dict) -> dict:
        self.require_calendar(identity_id, calendar_id)
        if payload.get("isDefault"):
            self._clear_default(identity_id)
        row = self._session.execute(
            text(
                "UPDATE calendar SET name = COALESCE(:name, name),"
                " color = COALESCE(:color, color), timezone = COALESCE(:timezone, timezone),"
                " is_default = COALESCE(:is_default, is_default), updated_at = now()"
                " WHERE id = :id RETURNING id, calendar_type, name, color, timezone, is_default"
            ),
            {
                "id": calendar_id,
                "name": payload.get("name"),
                "color": payload.get("color"),
                "timezone": payload.get("timezone"),
                "is_default": payload.get("isDefault"),
            },
        ).mappings().one()
        self._session.commit()
        return _calendar_view(row)

    def disable_calendar(self, identity_id: int, calendar_id: int) -> None:
        calendar = self.require_calendar(identity_id, calendar_id)
        if calendar["is_default"]:
            raise ApiError(ErrorCode.PARAM_INVALID, "默认日历不可删除，请先设置其他默认日历")
        self._session.execute(
            text("UPDATE calendar SET status = 'DISABLED', updated_at = now() WHERE id = :id"),
            {"id": calendar_id},
        )
        self._session.commit()

    def _clear_default(self, identity_id: int) -> None:
        self._session.execute(
            text(
                "UPDATE calendar SET is_default = false"
                " WHERE owner_identity_id = :identity AND is_default"
            ),
            {"identity": identity_id},
        )

    # ---------------------------------------------------------------- 日程
    def list_events(
        self, identity_id: int, calendar_ids: list[int] | None, start: datetime, end: datetime
    ) -> list[dict]:
        if start >= end:
            raise ApiError(ErrorCode.PARAM_INVALID, "结束时间必须晚于开始时间")
        if calendar_ids:
            for calendar_id in calendar_ids:
                self.require_calendar(identity_id, calendar_id)
            targets = calendar_ids
        else:
            targets = [item["id"] for item in self.list_calendars(identity_id)]
        if not targets:
            return []

        events = self._session.execute(
            text(
                "SELECT * FROM event WHERE deleted_at IS NULL AND status <> 'CANCELLED'"
                " AND calendar_id = ANY(:calendar_ids)"
                " AND ((rrule IS NOT NULL AND (rrule_until IS NULL OR rrule_until > :start))"
                "   OR (rrule IS NULL AND start_at < :end AND end_at > :start))"
                " ORDER BY start_at"
            ),
            {"calendar_ids": targets, "start": start, "end": end},
        ).mappings().all()
        if not events:
            return []

        event_ids = [row["id"] for row in events]
        exceptions: dict[int, list[dict]] = {}
        for row in self._session.execute(
            text("SELECT * FROM event_exception WHERE event_id = ANY(:ids)"), {"ids": event_ids}
        ).mappings():
            exceptions.setdefault(row["event_id"], []).append(dict(row))

        results: list[dict] = []
        for event in events:
            results.extend(
                recurrence.expand(dict(event), exceptions.get(event["id"], []), start, end)
            )
        results.sort(key=lambda item: (item["startAt"], item["eventId"]))
        return results

    def require_event(self, identity_id: int, event_id: int) -> dict:
        row = self._session.execute(
            text("SELECT * FROM event WHERE id = :id AND deleted_at IS NULL"), {"id": event_id}
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "日程不存在或不属于当前身份")
        self.require_calendar(identity_id, row["calendar_id"])
        return dict(row)

    def create_event(self, identity_id: int, payload: dict) -> dict:
        calendar_id = payload.get("calendarId") or self.default_calendar_id(identity_id)
        calendar = self.require_calendar(identity_id, calendar_id)
        _validate_range(payload["startAt"], payload["endAt"])
        recurrence.validate_rrule(payload.get("rrule"))
        row = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, creator_identity_id, source_type, title,"
                " description, location, start_at, end_at, all_day, timezone, rrule, status,"
                " updated_after_dispatch)"
                " VALUES (:calendar_id, :identity, 'PERSONAL', :title, :description, :location,"
                " :start_at, :end_at, :all_day, :timezone, :rrule, 'CONFIRMED', false)"
                " RETURNING *"
            ),
            {
                "calendar_id": calendar_id,
                "identity": identity_id,
                "title": payload["title"],
                "description": payload.get("description"),
                "location": payload.get("location"),
                "start_at": payload["startAt"],
                "end_at": payload["endAt"],
                "all_day": bool(payload.get("allDay")),
                "timezone": payload.get("timezone") or calendar["timezone"],
                "rrule": payload.get("rrule"),
            },
        ).mappings().one()
        self._session.commit()
        return _event_view(row)

    def update_event(self, identity_id: int, event_id: int, payload: dict) -> dict:
        event = self.require_event(identity_id, event_id)
        scope = (payload.get("scope") or "ALL").upper()
        if scope == "ALL":
            recurrence.validate_rrule(payload.get("rrule"))
            start = payload.get("startAt") or event["start_at"]
            end = payload.get("endAt") or event["end_at"]
            _validate_range(start, end)
            row = self._session.execute(
                text(
                    "UPDATE event SET title = COALESCE(:title, title),"
                    " description = COALESCE(:description, description),"
                    " location = COALESCE(:location, location), start_at = :start_at,"
                    " end_at = :end_at, all_day = COALESCE(:all_day, all_day),"
                    " timezone = COALESCE(:timezone, timezone),"
                    " rrule = COALESCE(:rrule, rrule), updated_at = now()"
                    " WHERE id = :id RETURNING *"
                ),
                {
                    "id": event_id,
                    "title": payload.get("title"),
                    "description": payload.get("description"),
                    "location": payload.get("location"),
                    "start_at": start,
                    "end_at": end,
                    "all_day": payload.get("allDay"),
                    "timezone": payload.get("timezone"),
                    "rrule": payload.get("rrule"),
                },
            ).mappings().one()
            self._session.commit()
            return _event_view(row)

        occurrence_date = _require_occurrence_date(payload.get("occurrenceDate"), scope)
        _require_recurring(event, scope)
        if scope == "THIS":
            self._upsert_exception(event_id, occurrence_date, "MODIFIED", payload)
            self._session.commit()
            return _event_view(event)

        recurrence.validate_rrule(payload.get("rrule"))
        return self._split_future(identity_id, event, occurrence_date, payload)

    def delete_event(self, identity_id: int, event_id: int, scope: str | None, occurrence_date) -> None:
        event = self.require_event(identity_id, event_id)
        effective = (scope or "ALL").upper()
        if effective == "ALL":
            self._session.execute(
                text(
                    "UPDATE event SET deleted_at = now(), status = 'CANCELLED', updated_at = now()"
                    " WHERE id = :id"
                ),
                {"id": event_id},
            )
            self._session.commit()
            return
        target = _require_occurrence_date(occurrence_date, effective)
        _require_recurring(event, effective)
        if effective == "THIS":
            self._upsert_exception(event_id, target, "CANCELLED", {})
        else:
            self._session.execute(
                text("UPDATE event SET rrule_until = :until, updated_at = now() WHERE id = :id"),
                {"id": event_id, "until": self._truncate_before(event, target)},
            )
        self._session.commit()

    def _split_future(self, identity_id: int, event: dict, occurrence_date, payload: dict) -> dict:
        start = recurrence.occurrence_start(event, occurrence_date)
        end = start + (event["end_at"] - event["start_at"])
        row = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, creator_identity_id, source_type, title,"
                " description, location, start_at, end_at, all_day, timezone, rrule, status,"
                " updated_after_dispatch)"
                " VALUES (:calendar_id, :identity, 'PERSONAL', :title, :description, :location,"
                " :start_at, :end_at, :all_day, :timezone, :rrule, 'CONFIRMED', false)"
                " RETURNING *"
            ),
            {
                "calendar_id": event["calendar_id"],
                "identity": identity_id,
                "title": payload.get("title") or event["title"],
                "description": _coalesce(payload.get("description"), event["description"]),
                "location": _coalesce(payload.get("location"), event["location"]),
                "start_at": payload.get("startAt") or start,
                "end_at": payload.get("endAt") or end,
                "all_day": _coalesce(payload.get("allDay"), event["all_day"]),
                "timezone": payload.get("timezone") or event["timezone"],
                "rrule": payload.get("rrule") or event["rrule"],
            },
        ).mappings().one()
        self._session.execute(
            text("UPDATE event SET rrule_until = :until, updated_at = now() WHERE id = :id"),
            {"id": event["id"], "until": self._truncate_before(event, occurrence_date)},
        )
        self._session.commit()
        return _event_view(row)

    def _truncate_before(self, event: dict, occurrence_date) -> datetime:
        """把原序列截止到「本次出现之前」。退让量必须大于微秒精度，否则会被四舍五入。"""
        return recurrence.occurrence_start(event, occurrence_date) - recurrence.TRUNCATE_MARGIN

    def _upsert_exception(
        self, event_id: int, occurrence_date, exception_type: str, payload: dict
    ) -> None:
        modified = exception_type == "MODIFIED"
        self._session.execute(
            text(
                "INSERT INTO event_exception (event_id, occurrence_date, exception_type,"
                " override_title, override_start_at, override_end_at)"
                " VALUES (:event_id, :date, :type, :title, :start_at, :end_at)"
                " ON CONFLICT (event_id, occurrence_date) DO UPDATE SET"
                " exception_type = EXCLUDED.exception_type,"
                " override_title = EXCLUDED.override_title,"
                " override_start_at = EXCLUDED.override_start_at,"
                " override_end_at = EXCLUDED.override_end_at"
            ),
            {
                "event_id": event_id,
                "date": occurrence_date,
                "type": exception_type,
                "title": payload.get("title") if modified else None,
                "start_at": payload.get("startAt") if modified else None,
                "end_at": payload.get("endAt") if modified else None,
            },
        )

    # ---------------------------------------------------------------- 待办
    def list_tasks(self, identity_id: int, status: str | None = None) -> list[dict]:
        rows = self._session.execute(
            text(
                "SELECT * FROM task WHERE owner_identity_id = :identity AND deleted_at IS NULL"
                " AND (:status IS NULL OR status = :status)"
                " ORDER BY sort_order, due_at NULLS LAST"
            ),
            {"identity": identity_id, "status": status},
        ).mappings()
        return [_task_view(row) for row in rows]

    def require_task(self, identity_id: int, task_id: int) -> dict:
        row = self._session.execute(
            text(
                "SELECT * FROM task WHERE id = :id AND deleted_at IS NULL"
                " AND owner_identity_id = :identity"
            ),
            {"id": task_id, "identity": identity_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.FORBIDDEN, "待办不存在或不属于当前身份")
        return dict(row)

    def create_task(self, identity_id: int, payload: dict) -> dict:
        calendar_id = payload.get("calendarId") or self.default_calendar_id(identity_id)
        self.require_calendar(identity_id, calendar_id)
        parent_id = payload.get("parentTaskId")
        if parent_id is not None:
            parent = self.require_task(identity_id, parent_id)
            if parent["parent_task_id"] is not None:
                raise ApiError(ErrorCode.PARAM_INVALID, "子任务不支持再嵌套子任务")
            calendar_id = parent["calendar_id"]
        row = self._session.execute(
            text(
                "INSERT INTO task (calendar_id, owner_identity_id, parent_task_id, title,"
                " description, due_at, all_day, status, priority, rrule, sort_order)"
                " VALUES (:calendar_id, :identity, :parent_id, :title, :description, :due_at,"
                " :all_day, 'TODO', :priority, :rrule, 0) RETURNING *"
            ),
            {
                "calendar_id": calendar_id,
                "identity": identity_id,
                "parent_id": parent_id,
                "title": payload["title"],
                "description": payload.get("description"),
                "due_at": payload.get("dueAt"),
                "all_day": bool(payload.get("allDay")),
                "priority": payload.get("priority") or "NORMAL",
                "rrule": payload.get("rrule"),
            },
        ).mappings().one()
        self._session.commit()
        return _task_view(row)

    def update_task(self, identity_id: int, task_id: int, payload: dict) -> dict:
        self.require_task(identity_id, task_id)
        completed = payload.get("status") == "DONE"
        row = self._session.execute(
            text(
                "UPDATE task SET title = COALESCE(:title, title),"
                " description = COALESCE(:description, description),"
                " due_at = COALESCE(:due_at, due_at), all_day = COALESCE(:all_day, all_day),"
                " priority = COALESCE(:priority, priority), status = COALESCE(:status, status),"
                " completed_at = CASE WHEN :status = 'DONE' THEN now()"
                "   WHEN :status IS NULL THEN completed_at ELSE NULL END,"
                " sort_order = COALESCE(:sort_order, sort_order), updated_at = now()"
                " WHERE id = :id RETURNING *"
            ),
            {
                "id": task_id,
                "title": payload.get("title"),
                "description": payload.get("description"),
                "due_at": payload.get("dueAt"),
                "all_day": payload.get("allDay"),
                "priority": payload.get("priority"),
                "status": payload.get("status"),
                "sort_order": payload.get("sortOrder"),
                "completed": completed,
            },
        ).mappings().one()
        self._session.commit()
        return _task_view(row)

    def complete_task(self, identity_id: int, task_id: int, completed: bool) -> dict:
        self.require_task(identity_id, task_id)
        row = self._session.execute(
            text(
                "UPDATE task SET status = :status,"
                " completed_at = CASE WHEN :completed THEN now() ELSE NULL END, updated_at = now()"
                " WHERE id = :id RETURNING *"
            ),
            {"id": task_id, "status": "DONE" if completed else "TODO", "completed": completed},
        ).mappings().one()
        self._session.commit()
        return _task_view(row)

    def delete_task(self, identity_id: int, task_id: int) -> None:
        self.require_task(identity_id, task_id)
        self._session.execute(
            text(
                "UPDATE task SET deleted_at = now()"
                " WHERE parent_task_id = :id AND deleted_at IS NULL"
            ),
            {"id": task_id},
        )
        self._session.execute(
            text("UPDATE task SET deleted_at = now() WHERE id = :id"), {"id": task_id}
        )
        self._session.commit()

    # ------------------------------------------------------------ 日程互转
    def convert_event_to_task(self, identity_id: int, event_id: int) -> dict:
        event = self.require_event(identity_id, event_id)
        row = self._session.execute(
            text(
                "INSERT INTO task (calendar_id, owner_identity_id, title, description, due_at,"
                " all_day, status, priority, sort_order)"
                " VALUES (:calendar_id, :identity, :title, :description, :due_at, :all_day,"
                " 'TODO', 'NORMAL', 0) RETURNING *"
            ),
            {
                "calendar_id": event["calendar_id"],
                "identity": identity_id,
                "title": event["title"],
                "description": event["description"],
                "due_at": event["end_at"],
                "all_day": event["all_day"],
            },
        ).mappings().one()
        self._session.execute(
            text("UPDATE event SET status = 'CANCELLED', updated_at = now() WHERE id = :id"),
            {"id": event_id},
        )
        self._session.commit()
        return _task_view(row)

    def convert_task_to_event(self, identity_id: int, task_id: int, payload: dict) -> dict:
        task = self.require_task(identity_id, task_id)
        calendar = self.require_calendar(identity_id, task["calendar_id"])
        start = payload.get("startAt") or task["due_at"]
        if start is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "该待办没有截止时间，请提供 startAt")
        end = payload.get("endAt") or (start + _ONE_HOUR())
        _validate_range(start, end)
        row = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, creator_identity_id, source_type, title,"
                " description, start_at, end_at, all_day, timezone, status, updated_after_dispatch)"
                " VALUES (:calendar_id, :identity, 'PERSONAL', :title, :description, :start_at,"
                " :end_at, :all_day, :timezone, 'CONFIRMED', false) RETURNING *"
            ),
            {
                "calendar_id": calendar["id"],
                "identity": identity_id,
                "title": task["title"],
                "description": task["description"],
                "start_at": start,
                "end_at": end,
                "all_day": task["all_day"],
                "timezone": calendar["timezone"],
            },
        ).mappings().one()
        self._session.execute(
            text("UPDATE task SET status = 'CANCELLED', updated_at = now() WHERE id = :id"),
            {"id": task_id},
        )
        self._session.commit()
        return _event_view(row)

    # ---------------------------------------------------------------- 提醒
    def list_reminders(self, identity_id: int, target_type: str, target_id: int) -> list[dict]:
        self._require_target(identity_id, target_type, target_id)
        rows = self._session.execute(
            text(
                "SELECT * FROM reminder WHERE target_type = :type AND target_id = :target"
                " AND identity_id = :identity ORDER BY minutes_before"
            ),
            {"type": target_type, "target": target_id, "identity": identity_id},
        ).mappings()
        return [_reminder_view(row) for row in rows]

    def set_reminders(self, identity_id: int, target_type: str, target_id: int, items: list[dict]) -> list[dict]:
        self._require_target(identity_id, target_type, target_id)
        self._session.execute(
            text(
                "DELETE FROM reminder WHERE target_type = :type AND target_id = :target"
                " AND identity_id = :identity"
            ),
            {"type": target_type, "target": target_id, "identity": identity_id},
        )
        for item in items:
            self._session.execute(
                text(
                    "INSERT INTO reminder (target_type, target_id, identity_id, occurrence_date,"
                    " minutes_before, channel, enabled)"
                    " VALUES (:type, :target, :identity, :occurrence_date, :minutes, 'PUSH', true)"
                ),
                {
                    "type": target_type,
                    "target": target_id,
                    "identity": identity_id,
                    "occurrence_date": item.get("occurrenceDate"),
                    "minutes": item["minutesBefore"],
                },
            )
        self._session.commit()
        return self.list_reminders(identity_id, target_type, target_id)

    def _require_target(self, identity_id: int, target_type: str, target_id: int) -> None:
        if target_type not in ("EVENT", "TASK"):
            raise ApiError(ErrorCode.PARAM_INVALID, f"targetType 取值非法: {target_type}")
        if target_type == "EVENT":
            self.require_event(identity_id, target_id)
        else:
            self.require_task(identity_id, target_id)


def _calendar_view(row) -> dict:
    return {
        "id": row["id"],
        "calendarType": row["calendar_type"],
        "name": row["name"],
        "color": row["color"],
        "timezone": row["timezone"],
        "isDefault": bool(row["is_default"]),
    }


def _event_view(row) -> dict:
    return {
        "id": row["id"],
        "calendarId": row["calendar_id"],
        "title": row["title"],
        "description": row["description"],
        "location": row["location"],
        "startAt": row["start_at"],
        "endAt": row["end_at"],
        "allDay": bool(row["all_day"]),
        "timezone": row["timezone"],
        "rrule": row["rrule"],
        "status": row["status"],
    }


def _task_view(row) -> dict:
    return {
        "id": row["id"],
        "calendarId": row["calendar_id"],
        "parentTaskId": row["parent_task_id"],
        "title": row["title"],
        "description": row["description"],
        "dueAt": row["due_at"],
        "allDay": bool(row["all_day"]),
        "status": row["status"],
        "completedAt": row["completed_at"],
        "priority": row["priority"],
        "sortOrder": row["sort_order"],
    }


def _reminder_view(row) -> dict:
    return {
        "id": row["id"],
        "targetType": row["target_type"],
        "targetId": row["target_id"],
        "minutesBefore": row["minutes_before"],
        "occurrenceDate": row["occurrence_date"],
        "channel": row["channel"],
        "enabled": bool(row["enabled"]),
    }


def _validate_range(start, end) -> None:
    if start is None or end is None or end <= start:
        raise ApiError(ErrorCode.EVENT_TIME_INVALID)


def _require_occurrence_date(value, scope: str):
    if value is None:
        raise ApiError(ErrorCode.PARAM_INVALID, f"scope={scope} 必须提供 occurrenceDate")
    if isinstance(value, str):
        return datetime.fromisoformat(value).date()
    return value


def _require_recurring(event: dict, scope: str) -> None:
    if not event.get("rrule"):
        raise ApiError(ErrorCode.PARAM_INVALID, f"非重复日程不支持 scope={scope}，请使用 scope=ALL")


def _coalesce(value, fallback):
    return fallback if value is None else value


def _ONE_HOUR():
    from datetime import timedelta

    return timedelta(hours=1)
