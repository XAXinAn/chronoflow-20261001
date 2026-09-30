"""授权通过之后**真正执行**写操作（对照 Java 版 `AgentWriteExecutor`）。

走的是和 REST 完全同一套 `PersonalService`：隔离沙盒、重复规则、地点成对约束一个都不少，
助手不会成为绕开校验的旁路。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from ..db import SessionLocal
from ..errors import ApiError, ErrorCode
from . import agent_times
from .agent_tools import TYPE_CREATE_EVENT, TYPE_DELETE_EVENT, TYPE_UPDATE_EVENT
from .personal import PersonalService

logger = logging.getLogger(__name__)

DEFAULT_TIMEZONE = "Asia/Shanghai"


@dataclass
class WriteOutcome:
    ok: bool
    json: str
    summary: str


def execute(identity_id: int, action: dict, zone: ZoneInfo) -> WriteOutcome:
    if not action or not action.get("type"):
        return _failed("不知道要执行什么操作")
    payload = action.get("payload") or {}
    try:
        if action["type"] == TYPE_CREATE_EVENT:
            return _create(identity_id, payload)
        if action["type"] == TYPE_UPDATE_EVENT:
            return _update(identity_id, payload)
        if action["type"] == TYPE_DELETE_EVENT:
            return _delete(identity_id, payload, zone)
        return _failed(f"不支持的操作：{action['type']}")
    except ApiError as ex:
        return _failed(ex.message or ErrorCode.PARAM_INVALID.name)
    except Exception as ex:  # noqa: BLE001 —— 写失败要把原因交回模型，而不是把整条流打断
        logger.warning("助手写操作失败: %s", ex)
        return _failed("执行失败，请稍后再试")


def _create(identity_id: int, payload: dict) -> WriteOutcome:
    with SessionLocal() as session:
        event = PersonalService(session).create_event(identity_id, {
            "title": payload.get("title"),
            "description": payload.get("description"),
            "locationName": payload.get("locationName"),
            "locationAddress": payload.get("locationAddress"),
            "locationDetail": payload.get("locationDetail"),
            "latitude": payload.get("latitude"),
            "longitude": payload.get("longitude"),
            "poiId": payload.get("poiId"),
            "at": payload.get("at"),
            "timezone": payload.get("timezone"),
        })
    return _ok(event, "已创建日程")


def _update(identity_id: int, payload: dict) -> WriteOutcome:
    event_id = payload.get("eventId")
    # 只送动作里真的带了的字段：update_event 是 COALESCE 语义，
    # 多送一个 null 就等于「不动」，但显式送空串才是「清空地点」
    request: dict = {"scope": "ALL"}
    for key in ("title", "description", "locationName", "locationAddress",
                "locationDetail", "poiId", "at", "timezone"):
        if key in payload:
            request[key] = payload[key]
    if payload.get("latitude") is not None:
        request["latitude"] = payload["latitude"]
        request["longitude"] = payload["longitude"]
    with SessionLocal() as session:
        event = PersonalService(session).update_event(identity_id, int(event_id), request)
    return _ok(event, "已修改日程")


def _delete(identity_id: int, payload: dict, zone: ZoneInfo) -> WriteOutcome:
    event_id = int(payload.get("eventId"))
    with SessionLocal() as session:
        service = PersonalService(session)
        event = service.require_event(identity_id, event_id)
        zone_of_event = _zone_of(event)
        summary = (f"已删除日程：{event['title']} "
                   + agent_times.format_point(event["at"], zone_of_event))
        service.delete_event(identity_id, event_id, "ALL", None)
    return WriteOutcome(
        ok=True,
        json=json.dumps({
            "status": "ok",
            "eventId": event_id,
            "deleted": True,
            "title": event["title"],
            "at": agent_times.format_short(event["at"], zone_of_event),
        }, ensure_ascii=False),
        summary=summary,
    )


def _ok(event: dict, verb: str) -> WriteOutcome:
    zone = _zone_of(event)
    return WriteOutcome(
        ok=True,
        json=json.dumps({
            "status": "ok",
            "eventId": event["id"],
            "title": event["title"],
            "at": agent_times.format_short(event["at"], zone),
        }, ensure_ascii=False),
        summary=f"{verb}：{event['title']} " + agent_times.format_point(event["at"], zone),
    )


def _zone_of(event: dict) -> ZoneInfo:
    from zoneinfo import ZoneInfoNotFoundError

    try:
        return ZoneInfo(event.get("timezone") or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TIMEZONE)


def _failed(reason: str | None) -> WriteOutcome:
    message = reason or ErrorCode.PARAM_INVALID.name
    return WriteOutcome(
        ok=False,
        json=json.dumps({"status": "failed", "error": message}, ensure_ascii=False),
        summary=f"这次没成：{message}",
    )
