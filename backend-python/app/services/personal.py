"""个人日历、日程、待办与提醒（spec §4.1）。"""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from . import recurrence
from .search import like_pattern
from .storage import validate_image_urls

DEFAULT_CALENDAR_NAME = "我的日程"

# 待办自己没有时区列，取所在日历的时区；没有就按第一版的默认时区（spec §7.3）
DEFAULT_TIMEZONE = "Asia/Shanghai"

# 「关联日程」候选列表的默认与最大条数（spec §4.1.6）
DEFAULT_LIST_LIMIT = 200
MAX_LIST_LIMIT = 500

# 枚举取值集中在这里校验：脏值以业务错误码返回，而不是写进库后被数据库约束拒绝
_STATUSES = {"CONFIRMED", "TENTATIVE", "CANCELLED"}
_AVAILABILITIES = {"BUSY", "FREE"}
_PRIORITIES = {"LOW", "NORMAL", "HIGH", "URGENT"}
_COORDINATE_SYSTEM = "GCJ-02"


def _choice(value, allowed, fallback, label):
    if value is None or (isinstance(value, str) and not value.strip()):
        return fallback
    normalized = str(value).strip().upper()
    if normalized not in allowed:
        raise ApiError(ErrorCode.PARAM_INVALID, f"{label}取值非法: {value}")
    return normalized


def _blank_to_none(value):
    return value if value is not None and str(value).strip() else None


def _place_columns(payload):
    """地点字段的统一处理：坐标必须成对，且一律标注 GCJ-02（spec §5.9）。"""
    lat = payload.get("latitude")
    lng = payload.get("longitude")
    if lat is None and lng is None:
        return {"latitude": None, "longitude": None, "coordinate_system": None}
    if lat is None or lng is None:
        raise ApiError(ErrorCode.PARAM_INVALID, "经纬度必须成对提供")
    if not -90 <= float(lat) <= 90 or not -180 <= float(lng) <= 180:
        raise ApiError(ErrorCode.PARAM_INVALID, "经纬度超出有效范围")
    return {"latitude": lat, "longitude": lng, "coordinate_system": _COORDINATE_SYSTEM}


def _event_columns(payload, defaults):
    """请求体 → event 表列值。编辑时空值交给 COALESCE 保留原值。"""
    columns = {
        "location_name": _blank_to_none(payload.get("locationName")),
        "location_address": _blank_to_none(payload.get("locationAddress")),
        # 详细地址：地图定位不到的那一层（教室 / 门牌）由用户手填，与地点相互独立（spec §5.9）
        "location_detail": _blank_to_none(payload.get("locationDetail")),
        "poi_id": _blank_to_none(payload.get("poiId")),
        "category": _blank_to_none(payload.get("category")),
        "url": _blank_to_none(payload.get("url")),
        "color": _blank_to_none(payload.get("color")),
        **_place_columns(payload),
    }
    if defaults:
        columns["status"] = _choice(payload.get("status"), _STATUSES, "CONFIRMED", "日程状态")
        columns["availability"] = _choice(payload.get("availability"), _AVAILABILITIES, "BUSY", "忙碌状态")
        columns["priority"] = _choice(payload.get("priority"), _PRIORITIES, "NORMAL", "优先级")
        columns["travel_time_minutes"] = payload.get("travelTimeMinutes")
    else:
        columns["status"] = (
            _choice(payload.get("status"), _STATUSES, None, "日程状态") if payload.get("status") else None
        )
        columns["availability"] = (
            _choice(payload.get("availability"), _AVAILABILITIES, None, "忙碌状态")
            if payload.get("availability")
            else None
        )
        columns["priority"] = (
            _choice(payload.get("priority"), _PRIORITIES, None, "优先级") if payload.get("priority") else None
        )
        columns["travel_time_minutes"] = payload.get("travelTimeMinutes")
    return columns


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
                "   OR (rrule IS NULL AND at >= :start AND at < :end))"
                " ORDER BY at"
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
        results.sort(key=lambda item: (item["at"], item["eventId"]))
        return results

    def list_all_events(self, identity_id: int, keyword: str | None, limit: int | None) -> list[dict]:
        """我的**全部日程**（「关联日程」候选，spec §4.1.6），按时间倒序，可按关键字过滤。

        不复用 `list_events`：它必须给时间范围、而且会把重复日程展开成每一次实例 ——
        拉一年就是几百条，当候选列表既慢又不准（用户要关联的是**那条日程**，
        而 `task.event_id` 指向的也正是序列本身）。所以这里返回原始序列、不展开。

        关键字与检索共用 `like_pattern`：空关键字得到 `%%`，
        于是「列全部」与「按关键字过滤」是同一条 SQL。
        """
        effective_limit = DEFAULT_LIST_LIMIT if limit is None else max(1, min(int(limit), MAX_LIST_LIMIT))
        rows = self._session.execute(
            text(
                "SELECT e.* FROM event e"
                " JOIN calendar c ON c.id = e.calendar_id"
                " WHERE c.owner_identity_id = :identity"
                " AND e.deleted_at IS NULL"
                " AND e.status <> 'CANCELLED'"
                " AND (e.title ILIKE :pattern ESCAPE '\\'"
                "      OR e.description ILIKE :pattern ESCAPE '\\'"
                "      OR e.location_name ILIKE :pattern ESCAPE '\\')"
                " ORDER BY e.at DESC"
                " LIMIT :limit"
            ),
            {
                "identity": identity_id,
                "pattern": like_pattern("" if keyword is None else keyword.strip()),
                "limit": effective_limit,
            },
        ).mappings().all()
        return [
            {
                "eventId": row["id"],
                "calendarId": row["calendar_id"],
                "title": row["title"],
                "locationName": row["location_name"],
                "locationDetail": row["location_detail"],
                "locationAddress": row["location_address"],
                "at": row["at"],
                "timezone": row["timezone"] or DEFAULT_TIMEZONE,
                # 一条重复序列只出现一次：它不是「某一次出现」
                "recurring": bool(row["rrule"]),
                "occurrenceDate": None,
                "modified": False,
            }
            for row in rows
        ]

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
        recurrence.validate_rrule(payload.get("rrule"))
        row = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, creator_identity_id, source_type, title,"
                " description, location_name, location_address, location_detail,"
                " latitude, longitude, poi_id,"
                " coordinate_system, at, timezone, rrule, status,"
                " availability, color, priority, category, url, travel_time_minutes,"
                " updated_after_dispatch)"
                " VALUES (:calendar_id, :identity, 'PERSONAL', :title, :description, :location_name,"
                " :location_address, :location_detail, :latitude, :longitude, :poi_id,"
                " :coordinate_system,"
                " :at, :timezone, :rrule, :status,"
                " :availability, :color, :priority, :category, :url, :travel_time_minutes, false)"
                " RETURNING *"
            ),
            {
                "calendar_id": calendar_id,
                "identity": identity_id,
                "title": payload["title"],
                "description": payload.get("description"),
                "at": payload["at"],
                "timezone": payload.get("timezone") or calendar["timezone"],
                "rrule": payload.get("rrule"),
                **_event_columns(payload, defaults=True),
            },
        ).mappings().one()
        self._session.commit()
        return _event_view(row)

    def update_event(self, identity_id: int, event_id: int, payload: dict) -> dict:
        event = self.require_event(identity_id, event_id)
        scope = (payload.get("scope") or "ALL").upper()
        if scope == "ALL":
            recurrence.validate_rrule(payload.get("rrule"))
            row = self._session.execute(
                text(
                    "UPDATE event SET title = COALESCE(:title, title),"
                    " description = COALESCE(:description, description),"
                    # 地点是一组联动字段：显式送空串表示「清空地点」，此时名称、地址、坐标一起清掉，
                    # 否则会留下「有坐标没名字」的脏数据，也过不了 coordinate_system 的成对约束
                    " location_name = CASE WHEN :clear_place THEN NULL"
                    "   ELSE COALESCE(:location_name, location_name) END,"
                    " location_address = CASE WHEN :clear_place THEN NULL"
                    "   ELSE COALESCE(:location_address, location_address) END,"
                    # 详细地址独立于地点：清空地点不该把用户手写的教室号一起抹掉
                    " location_detail = COALESCE(:location_detail, location_detail),"
                    " poi_id = CASE WHEN :clear_place THEN NULL ELSE COALESCE(:poi_id, poi_id) END,"
                    " latitude = CASE WHEN :clear_place THEN NULL ELSE COALESCE(:latitude, latitude) END,"
                    " longitude = CASE WHEN :clear_place THEN NULL ELSE COALESCE(:longitude, longitude) END,"
                    " coordinate_system = CASE WHEN :clear_place THEN NULL"
                    "   ELSE COALESCE(:coordinate_system, coordinate_system) END,"
                    " at = COALESCE(:at, at),"
                    " timezone = COALESCE(:timezone, timezone),"
                    " rrule = COALESCE(:rrule, rrule),"
                    " status = COALESCE(:status, status),"
                    " availability = COALESCE(:availability, availability),"
                    " color = COALESCE(:color, color),"
                    " priority = COALESCE(:priority, priority),"
                    " category = COALESCE(:category, category),"
                    " url = COALESCE(:url, url),"
                    " travel_time_minutes = COALESCE(:travel_time_minutes, travel_time_minutes),"
                    " updated_at = now()"
                    " WHERE id = :id RETURNING *"
                ),
                {
                    "id": event_id,
                    "title": payload.get("title"),
                    "description": payload.get("description"),
                    "at": payload.get("at"),
                    "timezone": payload.get("timezone"),
                    "rrule": payload.get("rrule"),
                    # 只有「显式送了空串」才清空地点；字段缺失或为 null 一律视为不修改，
                    # 与 Java 版保持一致（PATCH 的 null 语义是「不动」）
                    "clear_place": payload.get("locationName") is not None
                    and _blank_to_none(payload.get("locationName")) is None,
                    **_event_columns(payload, defaults=False),
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
            # 删除日程**不删除**关联的待办，只解除关联（spec §4.1.6）：
            # 待办是用户自己的事，不该被日程的删除带崩。
            self._session.execute(
                text("UPDATE task SET event_id = NULL, updated_at = now() WHERE event_id = :id"),
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
        row = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, creator_identity_id, source_type, title,"
                " description, location_name, location_address, location_detail,"
                " latitude, longitude, poi_id,"
                " coordinate_system, at, timezone, rrule, status,"
                " availability, color, priority, category, url, travel_time_minutes,"
                " updated_after_dispatch)"
                " VALUES (:calendar_id, :identity, 'PERSONAL', :title, :description, :location_name,"
                " :location_address, :location_detail, :latitude, :longitude, :poi_id,"
                " :coordinate_system,"
                " :at, :timezone, :rrule, :status,"
                " :availability, :color, :priority, :category, :url, :travel_time_minutes, false)"
                " RETURNING *"
            ),
            {
                "calendar_id": event["calendar_id"],
                "identity": identity_id,
                "title": payload.get("title") or event["title"],
                "description": _coalesce(payload.get("description"), event["description"]),
                "location_name": _coalesce(_blank_to_none(payload.get("locationName")), event["location_name"]),
                "location_address": _coalesce(payload.get("locationAddress"), event["location_address"]),
                "location_detail": _coalesce(payload.get("locationDetail"), event["location_detail"]),
                "latitude": _coalesce(payload.get("latitude"), event["latitude"]),
                "longitude": _coalesce(payload.get("longitude"), event["longitude"]),
                "poi_id": _coalesce(payload.get("poiId"), event["poi_id"]),
                "coordinate_system": event["coordinate_system"],
                "status": _choice(payload.get("status"), _STATUSES, None, "日程状态") or event["status"],
                "availability": _choice(payload.get("availability"), _AVAILABILITIES, None, "忙碌状态")
                or event["availability"],
                "priority": _choice(payload.get("priority"), _PRIORITIES, None, "优先级") or event["priority"],
                "color": _coalesce(payload.get("color"), event["color"]),
                "category": _coalesce(payload.get("category"), event["category"]),
                "url": _coalesce(payload.get("url"), event["url"]),
                "travel_time_minutes": _coalesce(payload.get("travelTimeMinutes"), event["travel_time_minutes"]),
                "at": payload.get("at") or start,
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
                " override_title, override_at)"
                " VALUES (:event_id, :date, :type, :title, :at)"
                " ON CONFLICT (event_id, occurrence_date) DO UPDATE SET"
                " exception_type = EXCLUDED.exception_type,"
                " override_title = EXCLUDED.override_title,"
                " override_at = EXCLUDED.override_at"
            ),
            {
                "event_id": event_id,
                "date": occurrence_date,
                "type": exception_type,
                "title": payload.get("title") if modified else None,
                "at": payload.get("at") if modified else None,
            },
        )

    # ---------------------------------------------------------------- 待办
    def list_tasks(self, identity_id: int, status: str | None = None) -> list[dict]:
        rows = self._session.execute(
            text(
                # LEFT JOIN 一次把关联日程的标题带出来，避免逐条待办再查一次日程
                "SELECT t.*, e.title AS event_title FROM task t"
                " LEFT JOIN event e ON e.id = t.event_id AND e.deleted_at IS NULL"
                " WHERE t.owner_identity_id = :identity AND t.deleted_at IS NULL"
                # 显式 CAST：不写类型时 PG 无法推断 NULL 参数的类型，
                # 不带 status 参数查列表会直接 500（AmbiguousParameter）
                " AND (CAST(:status AS text) IS NULL OR t.status = CAST(:status AS text))"
                " ORDER BY t.sort_order, t.due_at NULLS LAST"
            ),
            {"identity": identity_id, "status": status},
        ).mappings()
        return [_task_view(row) for row in rows]

    def _task_row(self, task_id: int):
        """按 id 读一条待办（带关联日程标题），供写操作返回最新状态。"""
        return self._session.execute(
            text(
                "SELECT t.*, e.title AS event_title FROM task t"
                " LEFT JOIN event e ON e.id = t.event_id AND e.deleted_at IS NULL"
                " WHERE t.id = :id"
            ),
            {"id": task_id},
        ).mappings().one()

    def require_owned_event(self, identity_id: int, event_id: int) -> None:
        """关联的日程必须是当前身份自己的，不能挂到别人的日程上（spec §4.1.6）。"""
        row = self._session.execute(
            text("SELECT id, calendar_id FROM event WHERE id = :id AND deleted_at IS NULL"),
            {"id": event_id},
        ).mappings().first()
        if row is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "关联的日程不存在")
        self.require_calendar(identity_id, row["calendar_id"])

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
        event_id = payload.get("eventId")
        if event_id is not None:
            self.require_owned_event(identity_id, event_id)
        # 待办同样支持重复（spec §4.1.2）；规则写错就在这里挡住，别等展开时才炸
        rrule = payload.get("rrule") or None
        recurrence.validate_rrule(rrule)
        row = self._session.execute(
            text(
                "INSERT INTO task (calendar_id, owner_identity_id, parent_task_id, title,"
                " description, event_id, due_at, status, priority, rrule, images, sort_order)"
                " VALUES (:calendar_id, :identity, :parent_id, :title, :description, :event_id,"
                " :due_at, 'TODO', :priority, :rrule, CAST(:images AS jsonb), 0)"
                " RETURNING *"
            ),
            {
                "calendar_id": calendar_id,
                "identity": identity_id,
                "parent_id": parent_id,
                "event_id": event_id,
                "title": payload["title"],
                "description": payload.get("description"),
                "due_at": payload.get("dueAt"),
                "priority": payload.get("priority") or "NORMAL",
                "rrule": rrule,
                # jsonb 列不能用数组适配器直接塞：显式序列化再 CAST
                "images": json.dumps(validate_image_urls(payload.get("images")), ensure_ascii=False),
            },
        ).mappings().one()
        self._session.commit()
        return _task_view(self._task_row(row["id"]))

    def update_task(self, identity_id: int, task_id: int, payload: dict) -> dict:
        self.require_task(identity_id, task_id)
        completed = payload.get("status") == "DONE"
        # 重复规则：null = 不修改；空串 = 清空（回到「不重复」），与日程同一套语义
        rrule = payload.get("rrule")
        if rrule is not None:
            rrule = rrule or None
            recurrence.validate_rrule(rrule)
        # 先看「显式清空」再看赋值：否则一旦设过截止时间就再也回不到「待安排」
        clear_due = bool(payload.get("clearDueAt"))
        # 关联同理：null 在 PATCH 里是「不修改」，解绑必须靠 clearEvent 显式表达
        if payload.get("clearEvent"):
            event_id = None
            clear_event = True
        else:
            event_id = payload.get("eventId")
            clear_event = False
            if event_id is not None:
                self.require_owned_event(identity_id, event_id)
        row = self._session.execute(
            text(
                "UPDATE task SET title = COALESCE(:title, title),"
                " description = COALESCE(:description, description),"
                " event_id = CASE WHEN :clear_event THEN NULL ELSE COALESCE(:event_id, event_id) END,"
                " due_at = CASE WHEN :clear_due THEN NULL ELSE COALESCE(:due_at, due_at) END,"
                " priority = COALESCE(:priority, priority), status = COALESCE(:status, status),"
                " rrule = CASE WHEN :rrule_set THEN :rrule ELSE rrule END,"
                # 图片：null = 不修改；传空数组才是「删光所有图片」
                " images = COALESCE(CAST(:images AS jsonb), images),"
                " completed_at = CASE WHEN :status = 'DONE' THEN now()"
                "   WHEN :status IS NULL THEN completed_at ELSE NULL END,"
                " sort_order = COALESCE(:sort_order, sort_order), updated_at = now()"
                " WHERE id = :id RETURNING *"
            ),
            {
                "id": task_id,
                "clear_due": clear_due,
                "clear_event": clear_event,
                "event_id": event_id,
                "title": payload.get("title"),
                "description": payload.get("description"),
                "due_at": payload.get("dueAt"),
                "priority": payload.get("priority"),
                "status": payload.get("status"),
                "rrule": rrule,
                "rrule_set": payload.get("rrule") is not None,
                "images": json.dumps(validate_image_urls(payload.get("images")), ensure_ascii=False)
                if payload.get("images") is not None
                else None,
                "sort_order": payload.get("sortOrder"),
                "completed": completed,
            },
        ).mappings().one()
        self._session.commit()
        return _task_view(self._task_row(task_id))

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
                " status, priority, sort_order)"
                " VALUES (:calendar_id, :identity, :title, :description, :due_at,"
                " 'TODO', 'NORMAL', 0) RETURNING *"
            ),
            {
                "calendar_id": event["calendar_id"],
                "identity": identity_id,
                "title": event["title"],
                "description": event["description"],
                "due_at": event["at"],
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
        at = payload.get("at") or task["due_at"]
        if at is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "该待办没有截止时间，请提供 at")
        row = self._session.execute(
            text(
                "INSERT INTO event (calendar_id, creator_identity_id, source_type, title,"
                " description, at, timezone, status, updated_after_dispatch)"
                " VALUES (:calendar_id, :identity, 'PERSONAL', :title, :description, :at,"
                " :timezone, 'CONFIRMED', false) RETURNING *"
            ),
            {
                "calendar_id": calendar["id"],
                "identity": identity_id,
                "title": task["title"],
                "description": task["description"],
                "at": at,
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

    def upcoming_reminders(self, identity_id: int, start: datetime, end: datetime) -> list[dict]:
        """未来一段时间内所有要响的提醒（App 启动 / 回到前台时重排本地通知用，spec §4.5）。

        重复日程按**展开后的每一次实例**给出：客户端只拿得到 RRULE 字符串，
        自己展开等于把 rrule 库再实现一遍，而且两版展开规则一旦不一致，
        「某条重复日程在这台手机上不响」这种问题几乎无法排查。展开由服务端做一次。
        """
        _validate_range(start, end)
        rows = self._session.execute(
            text(
                "SELECT * FROM reminder WHERE identity_id = :identity AND enabled"
                " ORDER BY minutes_before"
            ),
            {"identity": identity_id},
        ).mappings().all()
        if not rows:
            return []

        event_minutes: dict[int, list[int]] = {}
        task_minutes: dict[int, list[int]] = {}
        for row in rows:
            bucket = event_minutes if row["target_type"] == "EVENT" else task_minutes
            bucket.setdefault(row["target_id"], []).append(row["minutes_before"])

        entries: list[dict] = []
        if event_minutes:
            for occurrence in self.list_events(identity_id, None, start, end):
                minutes = event_minutes.get(occurrence["eventId"])
                if minutes is None:
                    continue
                entries.append(
                    {
                        "targetType": "EVENT",
                        "targetId": occurrence["eventId"],
                        "occurrenceDate": occurrence["occurrenceDate"],
                        "title": occurrence["title"],
                        "locationName": occurrence.get("locationName"),
                        "at": occurrence["at"],
                        "timezone": occurrence.get("timezone") or DEFAULT_TIMEZONE,
                        "minutesBefore": sorted(set(minutes)),
                    }
                )
        if task_minutes:
            entries.extend(self._task_reminder_entries(identity_id, start, end, task_minutes))

        entries.sort(key=lambda item: (item["at"], item["targetType"], item["targetId"]))
        return entries

    def _task_reminder_entries(
        self, identity_id: int, start: datetime, end: datetime, task_minutes: dict[int, list[int]]
    ) -> list[dict]:
        """待办排期。

        只取「待办中（TODO）且有截止时间」的：已完成 / 已取消的待办再到点提醒一次，
        只会让用户觉得提醒不准（与列表里不展示它们是一个口径）。
        时区取所在日历的时区 —— 待办自己没有时区列，而「只说了哪一天」的提醒基准（当地 09:00）
        需要一个时区才算得对。
        """
        rows = self._session.execute(
            text(
                "SELECT * FROM task WHERE owner_identity_id = :identity AND status = 'TODO'"
                " AND deleted_at IS NULL AND id = ANY(:ids)"
                " AND due_at > :start AND due_at <= :end"
            ),
            {"identity": identity_id, "ids": list(task_minutes), "start": start, "end": end},
        ).mappings().all()
        if not rows:
            return []
        zones = {
            item["id"]: (item.get("timezone") or DEFAULT_TIMEZONE)
            for item in self.list_calendars(identity_id)
        }
        return [
            {
                "targetType": "TASK",
                "targetId": row["id"],
                "occurrenceDate": None,
                "title": row["title"],
                "locationName": None,
                "at": row["due_at"],
                "timezone": zones.get(row["calendar_id"], DEFAULT_TIMEZONE),
                "minutesBefore": sorted(set(task_minutes[row["id"]])),
            }
            for row in rows
        ]

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
        "locationName": row["location_name"],
        "locationAddress": row["location_address"],
        "locationDetail": row["location_detail"],
        "latitude": _num(row["latitude"]),
        "longitude": _num(row["longitude"]),
        "poiId": row["poi_id"],
        "coordinateSystem": row["coordinate_system"],
        "at": row["at"],
        "timezone": row["timezone"],
        "rrule": row["rrule"],
        "status": row["status"],
        "availability": row["availability"],
        "color": row["color"],
        "priority": row["priority"],
        "category": row["category"],
        "url": row["url"],
        "travelTimeMinutes": row["travel_time_minutes"],
    }


def _num(value):
    """NUMERIC 列在 psycopg 下是 Decimal，转成 float 才能与 Java 版输出一致（JSON 数字）。"""
    return float(value) if value is not None else None


def _task_view(row) -> dict:
    # event_title 来自 LEFT JOIN；单条读写时由 _task_row 补上，缺失即视为未关联
    keys = row.keys() if hasattr(row, "keys") else []
    event_title = row["event_title"] if "event_title" in keys else None
    images = row["images"] if "images" in keys else []
    if isinstance(images, str):  # 驱动返回字符串时也要能读
        images = json.loads(images)
    return {
        "id": row["id"],
        "calendarId": row["calendar_id"],
        "parentTaskId": row["parent_task_id"],
        "eventId": row["event_id"],
        # 关联日程的标题由服务端带出来，列表就不必再逐条查日程（避免 N+1）
        "eventTitle": event_title,
        "title": row["title"],
        "description": row["description"],
        "dueAt": row["due_at"],
        "status": row["status"],
        "completedAt": row["completed_at"],
        "priority": row["priority"],
        # 重复规则（spec §4.1.2）：待办也支持「每周五交周报」这类规则
        "rrule": row["rrule"],
        # 图片附件的相对 URL（spec §4.1.3）
        "images": images or [],
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
    """查询窗口校验（日程本身只有一个时间点，不存在"起止"合法性问题）。"""
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
