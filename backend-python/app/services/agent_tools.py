"""助手能调用的工具（spec §11 阶段三，对照 Java 版 `AgentToolRegistry`）。

只有五个，而且五个都只碰「当前用户自己的个人日程」：
list_my_events 按时间范围查、read_my_event_note 读备注全文（都直接执行、不出授权）；
create_my_event / update_my_event / delete_my_event 只产出「待授权」动作，
用户点了「允许」之后才由 `agent_write` 真正写入。

名字里的 my_ 前缀是刻意的：组织日程将来以**新工具**的形式加进来
（例如 list_org_events），而不是把这五个改造成"既能个人又能组织"，
那正是越权最容易发生的地方。所有查询与写入都经 `_owned_event` 收敛到
当前账号的个人身份上，他人的日程一律当"找不到"。

每个工具除了给模型的结果（json），还会产出一行**给用户看的**摘要 + 明细，
让"它到底做了什么"在对话里看得见。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

from ..db import SessionLocal
from ..errors import ApiError
from . import agent_times
from .geo import GeoService
from .personal import PersonalService

logger = logging.getLogger(__name__)

LIST_MY_EVENTS = "list_my_events"
READ_MY_EVENT_NOTE = "read_my_event_note"
CREATE_MY_EVENT = "create_my_event"
UPDATE_MY_EVENT = "update_my_event"
DELETE_MY_EVENT = "delete_my_event"

TYPE_CREATE_EVENT = "create_event"
TYPE_UPDATE_EVENT = "update_event"
TYPE_DELETE_EVENT = "delete_event"

# 一行工具记录最多展开几条明细
DETAIL_LIMIT = 3
# 单次读备注的**硬上限**：备注可能几千字，一次全塞进上下文既贵又没用
NOTE_READ_MAX = 500
# 列表里备注只给这么长的预览
NOTE_PREVIEW_LIMIT = 60

_READ_ONLY = {LIST_MY_EVENTS, READ_MY_EVENT_NOTE}


@dataclass
class ToolOutcome:
    """一次工具调用的结果。

    json 回灌给模型的工具结果（紧凑 JSON）；action 是写操作产出的待授权动作（查询类为 None）；
    row 是给用户看的一行（摘要 + 明细）。
    """

    json: str
    action: dict | None = None
    read_only: bool = True
    summary: str = ""
    detail: list[str] = field(default_factory=list)


def _failed(reason: str) -> ToolOutcome:
    return ToolOutcome(
        json=json.dumps({"error": reason}, ensure_ascii=False),
        action=None,
        read_only=True,
        summary="这次没成",
        detail=[reason],
    )


def is_read_only(tool_name: str | None) -> bool:
    """查询类（只读）：服务端据此决定是直接执行还是先申请授权。"""
    return tool_name in _READ_ONLY


def specs() -> list[dict]:
    """给模型的工具声明（OpenAI function calling 的 tools[]）。"""
    return [
        _spec(
            LIST_MY_EVENTS,
            "查当前用户**自己的个人日程**（不含组织下发的）。日程**只有一个时间点**（字段 at），"
            "没有开始 / 结束之分。from 与 to 是**查询窗口**，都必填；不知道范围时先用一个合理窗口"
            "（例如今天起未来 30 天）再逐步收窄。结果超过 20 条时不会给数据，只回一句「太多了」，"
            "这时要用更小的窗口重新调用。",
            {
                "from": {"type": "string", "description": "查询窗口起点，ISO 8601 带时区，必填"},
                "to": {"type": "string", "description": "查询窗口终点（不含），ISO 8601 带时区，必填"},
                "keyword": {"type": "string", "description": "标题 / 地点 / 备注关键字，可选"},
            },
            ["from", "to"],
        ),
        _spec(
            READ_MY_EVENT_NOTE,
            "读某条**个人日程**的备注全文，必须给范围：offset（从第几个字开始，从 0 起）与 length"
            f"（这次要读多少字，最多 {NOTE_READ_MAX} 字，服务端会夹到上限）。返回里带 total（备注总字数）"
            f"与 hasMore，需要全文就按 offset 继续翻。列表里的备注只是 {NOTE_PREVIEW_LIMIT} 字预览，"
            "用户问备注细节时用它。",
            {
                "eventId": {"type": "integer", "description": f"{LIST_MY_EVENTS} 返回的 id"},
                "offset": {"type": "integer", "description": "起始位置（0 起）"},
                "length": {"type": "integer", "description": f"本次读取字数，最大 {NOTE_READ_MAX}"},
            },
            ["eventId", "offset", "length"],
        ),
        _spec(
            CREATE_MY_EVENT,
            "为用户创建一条**个人**日程。调用它不会立刻创建：服务端会向用户申请一次授权，"
            "用户允许后才真正写入。日程**只有一个时间点**：用户说几点就填几点，不要自己编时长。"
            "用户明说「一整天」「就那一天」「全天」这类、没有具体几点时，就填**那天 00:00**"
            "（当天 00:00 表示「就这一天」）；用户压根没提时间就先问一句几点。缺标题就先问清楚。",
            {
                "title": {"type": "string", "description": "日程标题"},
                "at": {"type": "string", "description": "日程时间，ISO 8601 带时区"},
                "locationName": {
                    "type": "string",
                    "description": "地点的文字（例如「西湖」「会议室A」）；"
                                   "服务端会试着匹配地图地点，匹配不到就放进详细地址",
                },
                "description": {"type": "string", "description": "备注，可选"},
            },
            ["title", "at"],
        ),
        _spec(
            UPDATE_MY_EVENT,
            f"修改**当前用户自己的个人日程**（改标题 / 时间 / 地点 / 备注）。调用前先用 {LIST_MY_EVENTS}"
            " 找到那条日程的 id；只填空需要改的字段，其余留空表示不动。同样要用户授权后才生效。",
            {
                "eventId": {"type": "integer", "description": f"{LIST_MY_EVENTS} 返回的 id"},
                "title": {"type": "string", "description": "新的标题，不改就留空"},
                "at": {"type": "string", "description": "新的时间，不改就留空"},
                "locationName": {
                    "type": "string",
                    "description": "地点文字，不改就留空；传空字符串表示清空地点",
                },
                "description": {"type": "string", "description": "备注，不改就留空"},
            },
            ["eventId"],
        ),
        _spec(
            DELETE_MY_EVENT,
            f"删除**当前用户自己的个人日程**。调用前先用 {LIST_MY_EVENTS} 找到它。"
            "同样要用户授权后才生效；组织下发的日程不在这个工具的范围内。",
            {"eventId": {"type": "integer", "description": f"{LIST_MY_EVENTS} 返回的 id"}},
            ["eventId"],
        ),
    ]


def _spec(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


def invoke(scope, call: dict, action_id: str | None,
           now: datetime, zone: ZoneInfo) -> ToolOutcome:
    """执行一次工具调用。action_id 只给写操作用（由调用方按顺序生成）。"""
    try:
        raw = call.get("arguments")
        args = json.loads(raw) if raw else {}
        if not isinstance(args, dict):
            args = {}
    except (ValueError, TypeError):
        return _failed("参数不是合法 JSON，请重新调用并给出合法参数")

    name = call.get("name") or ""
    if name == LIST_MY_EVENTS:
        return _list_events(scope, args, zone)
    if name == READ_MY_EVENT_NOTE:
        return _read_note(scope, args, zone)
    if name == CREATE_MY_EVENT:
        return _create_event(args, action_id, zone)
    if name == UPDATE_MY_EVENT:
        return _update_event(scope, args, action_id, zone)
    if name == DELETE_MY_EVENT:
        return _delete_event(scope, args, action_id, zone)
    return _failed(f"不支持的工具：{name}")


# ----------------------------------------------------------------- 查询（只读）


def _list_events(scope, args: dict, zone: ZoneInfo) -> ToolOutcome:
    start = agent_times.parse(_text(args, "from"), zone)
    end = agent_times.parse(_text(args, "to"), zone)
    if start is None or end is None:
        return _failed("需要 from 与 to（ISO 8601 带时区）作为查询窗口，请先向用户确认")
    if start >= end:
        return _failed("to 必须晚于 from")

    keyword = _text(args, "keyword")
    try:
        with SessionLocal() as session:
            occurrences = PersonalService(session).list_events(
                scope.personal_identity_id, None, start, end
            )
            # 备注预览与关键词匹配都要看备注，所以统一把日程实体取一次
            ids = sorted({item["eventId"] for item in occurrences})
            rows = (
                session.execute(text("SELECT * FROM event WHERE id = ANY(:ids)"), {"ids": ids})
                .mappings().all()
                if ids else []
            )
    except ApiError as ex:
        return _failed(ex.message or str(ex))

    events_by_id = {row["id"]: row for row in rows}
    needle = (keyword or "").strip().lower()
    visible = []
    for occurrence in occurrences:
        row = events_by_id.get(occurrence["eventId"])
        if needle and needle not in _searchable(row):
            continue
        note = (row["description"] if row is not None and row["description"] else "")
        visible.append({
            "eventId": occurrence["eventId"],
            "title": occurrence["title"],
            "at": occurrence["at"],
            "locationName": occurrence.get("locationName"),
            "locationDetail": occurrence.get("locationDetail"),
            "notePreview": _preview(note) if note.strip() else None,
            "noteLength": len(note),
            "recurring": bool(occurrence.get("recurring")),
            "occurrenceDate": occurrence.get("occurrenceDate"),
        })
    visible.sort(key=lambda item: (item["at"], item["eventId"]))

    limit = _event_limit()
    # 超过上限就**不给数据**：给半截列表会让模型说出"就这些"，比不答更糟
    if len(visible) > limit:
        hint = f"结果超过 {limit} 条，请先缩小时间范围（例如限定到某一天或几天）再查"
        return ToolOutcome(
            json=json.dumps({"tooMany": True, "total": len(visible), "hint": hint},
                            ensure_ascii=False),
            read_only=True,
            summary=f"日程较多（共 {len(visible)} 条）",
            detail=[hint],
        )

    payload: dict = {"events": [], "total": len(visible)}
    detail: list[str] = []
    if keyword and keyword.strip():
        detail.append(f"关键词「{keyword.strip()}」")
    for item in visible:
        entry = {
            "id": item["eventId"],
            "title": item["title"],
            "at": agent_times.iso(item["at"], zone),
        }
        if item["locationName"]:
            entry["location"] = item["locationName"]
        elif item["locationDetail"]:
            entry["locationDetail"] = item["locationDetail"]
        if item["notePreview"]:
            entry["notePreview"] = item["notePreview"]
            entry["noteLength"] = item["noteLength"]
        entry["recurring"] = item["recurring"]
        if item["occurrenceDate"] is not None:
            entry["occurrenceDate"] = str(item["occurrenceDate"])
        payload["events"].append(entry)
        if len(detail) <= DETAIL_LIMIT:
            detail.append(_describe(item, zone))
    if not visible:
        payload["note"] = "这个时间范围内没有日程"

    summary = "已查日程 · 没有安排" if not visible else f"已查日程 · {len(visible)} 条"
    return ToolOutcome(json=json.dumps(payload, ensure_ascii=False), read_only=True,
                       summary=summary, detail=detail)


def _read_note(scope, args: dict, zone: ZoneInfo) -> ToolOutcome:
    event_id = args.get("eventId")
    if not isinstance(event_id, int):
        return _failed(f"缺少 eventId，请先用 {LIST_MY_EVENTS} 找到那条日程")
    offset = args.get("offset")
    length = args.get("length")
    if not isinstance(offset, int) or not isinstance(length, int) or offset < 0 or length <= 0:
        return _failed(f"要读备注必须给 offset（0 起）与 length（1..{NOTE_READ_MAX}）")

    with SessionLocal() as session:
        event = _owned_event(session, scope.personal_identity_id, event_id)
    if event is None:
        return _failed("找不到这条日程，它可能不在你的个人日程里")

    note = event["description"] or ""
    total = len(note)
    effective = min(length, NOTE_READ_MAX)
    start = min(offset, total)
    end = min(start + effective, total)
    slice_ = note[start:end]
    payload = {
        "eventId": event_id,
        "title": event["title"],
        "total": total,
        "offset": start,
        "length": len(slice_),
        "maxLength": NOTE_READ_MAX,
        "hasMore": end < total,
        "text": slice_,
    }
    summary = "已读备注 · 这条没有备注" if total == 0 else f"已读备注 · {start}-{end} / 共 {total} 字"
    detail = [] if not slice_.strip() else [
        slice_[:NOTE_PREVIEW_LIMIT] + "…" if len(slice_) > NOTE_PREVIEW_LIMIT else slice_
    ]
    return ToolOutcome(json=json.dumps(payload, ensure_ascii=False), read_only=True,
                       summary=summary, detail=detail)


# ------------------------------------------------------- 写操作（待用户授权）


def _create_event(args: dict, action_id: str | None, zone: ZoneInfo) -> ToolOutcome:
    title = _text(args, "title")
    at = agent_times.parse(_text(args, "at"), zone)
    if not title or at is None:
        return _failed("还缺日程标题或时间，请先向用户确认后再调用")
    payload: dict = {"title": title.strip(), "at": agent_times.iso(at, zone)}
    _apply_location(payload, _text(args, "locationName"))
    description = _text(args, "description")
    if description:
        payload["description"] = description.strip()

    summary = f"创建日程：{title.strip()} {agent_times.format_point(at, zone)}"
    return ToolOutcome(
        json=_pending_json(action_id, CREATE_MY_EVENT),
        action={"actionId": action_id, "type": TYPE_CREATE_EVENT,
                "summary": summary, "payload": payload},
        read_only=False,
        summary="已申请创建",
        detail=[summary],
    )


def _update_event(scope, args: dict, action_id: str | None, zone: ZoneInfo) -> ToolOutcome:
    event_id = args.get("eventId")
    if not isinstance(event_id, int):
        return _failed(f"缺少 eventId，请先用 {LIST_MY_EVENTS} 找到要改的那条日程")
    with SessionLocal() as session:
        event = _owned_event(session, scope.personal_identity_id, event_id)
    if event is None:
        return _failed("找不到这条日程，它可能不在你的个人日程里")

    at_value = event["at"]
    payload: dict = {
        "eventId": event_id,
        "previous": {"title": event["title"], "at": agent_times.iso(at_value, zone)},
        "recurring": bool(event["rrule"]),
    }
    if event["location_name"]:
        # 列名保持 DB 语义：previous 给的是"改之前长什么样"
        payload["previous"]["locationName"] = event["location_name"]

    changes: list[str] = []
    title = _text(args, "title")
    if title:
        payload["title"] = title.strip()
        changes.append(f"标题改为「{title.strip()}」")
    at = agent_times.parse(_text(args, "at"), zone)
    if at is not None:
        payload["at"] = agent_times.iso(at, zone)
        changes.append("时间改为 " + agent_times.format_point(at, zone))
    if "locationName" in args:
        location_text = args.get("locationName") or ""
        if not location_text.strip():
            payload["locationName"] = None
            payload["locationDetail"] = None
            changes.append("清空地点")
        else:
            _apply_location(payload, location_text)
            changes.append(f"地点改为「{location_text.strip()}」")
    if "description" in args:
        payload["description"] = args.get("description") or ""
        changes.append("备注已更新")

    if not changes:
        return _failed("没有给出要修改的字段，请先问清用户要改什么")
    summary = f"修改日程：{event['title']} → " + "，".join(changes)
    return ToolOutcome(
        json=_pending_json(action_id, UPDATE_MY_EVENT),
        action={"actionId": action_id, "type": TYPE_UPDATE_EVENT,
                "summary": summary, "payload": payload},
        read_only=False,
        summary="已申请修改",
        detail=[summary],
    )


def _delete_event(scope, args: dict, action_id: str | None, zone: ZoneInfo) -> ToolOutcome:
    event_id = args.get("eventId")
    if not isinstance(event_id, int):
        return _failed(f"缺少 eventId，请先用 {LIST_MY_EVENTS} 找到要删的那条日程")
    with SessionLocal() as session:
        event = _owned_event(session, scope.personal_identity_id, event_id)
    if event is None:
        # 不区分"别人的日程"与"不存在的日程"：都不该让助手确认存在性
        return _failed("找不到这条日程，它可能不在你的个人日程里")

    payload: dict = {
        "eventId": event_id,
        "title": event["title"],
        "at": agent_times.iso(event["at"], zone),
        "recurring": bool(event["rrule"]),
    }
    if event["location_name"]:
        payload["locationName"] = event["location_name"]
    if event["location_detail"]:
        payload["locationDetail"] = event["location_detail"]

    summary = f"删除日程：{event['title']} {agent_times.format_point(event['at'], zone)}"
    return ToolOutcome(
        json=_pending_json(action_id, DELETE_MY_EVENT),
        action={"actionId": action_id, "type": TYPE_DELETE_EVENT,
                "summary": summary, "payload": payload},
        read_only=False,
        summary="已申请删除",
        detail=[summary],
    )


# ------------------------------------------------------------------- 内部工具


def _owned_event(session, identity_id: int, event_id: int) -> dict | None:
    """属于当前用户的个人日程就返回它，否则 None（他人的一律当"找不到"）。"""
    try:
        return PersonalService(session).require_event(identity_id, event_id)
    except ApiError:
        return None


def _apply_location(payload: dict, location_text: str | None) -> None:
    """地点分两层（spec §5.9）：地图上的地点（名称 + 地址 + 坐标）与手写的详细地址。

    「会议室A」「3 号楼 305」这类地图上根本没有的名字只能落在详细地址；
    早期版本把它写进 locationName，界面上就出现一个导航不了的假地点。
    """
    if not location_text or not location_text.strip():
        return
    place = _resolve_place(location_text)
    if place is None:
        payload["locationDetail"] = location_text.strip()
        return
    payload["locationName"] = place.get("name")
    if place.get("address"):
        payload["locationAddress"] = place["address"]
    if place.get("latitude") is not None:
        payload["latitude"] = place["latitude"]
    if place.get("longitude") is not None:
        payload["longitude"] = place["longitude"]
    if place.get("poiId"):
        payload["poiId"] = place["poiId"]


def _resolve_place(value: str) -> dict | None:
    """把用户说的地点文字匹配成地图上的地点（破坏性最小的保守匹配）。

    只有结果名与用户说的基本一致才会认；宁可不给坐标，也不要给错坐标——
    用户点「导航」跑错地方比看到一句「3 号楼 305」糟得多。
    """
    try:
        for place in GeoService().search_places(value.strip(), None, None, None, 5):
            if _same_place(value, place.get("name")):
                return place
    except Exception as ex:  # noqa: BLE001 —— 地点解析失败只该降级，不该让整条工具挂掉
        logger.debug("助手地点解析失败，退化为详细地址: %s", ex)
    return None


def _same_place(spoken: str, place_name: str | None) -> bool:
    if not place_name:
        return False
    left = _normalize_place(spoken)
    right = _normalize_place(place_name)
    return bool(left) and (left == right or left in right or right in left)


def _normalize_place(value: str | None) -> str:
    return re.sub(r"[\s\W_·（）()【】\[\]]+", "", (value or "").lower())


def _pending_json(action_id: str | None, action_type: str) -> str:
    return json.dumps({
        "status": "pending_authorization",
        "actionId": action_id,
        "type": action_type,
        "note": "已向用户申请授权；用户在界面上点「允许」后才真正写入。"
                "不要再重复调用这个工具，也不要在这条结果之后再执行别的操作。",
    }, ensure_ascii=False)


def _describe(item: dict, zone: ZoneInfo) -> str:
    line = f"{item['title']} · {agent_times.format_point(item['at'], zone)}"
    place = item["locationName"] or item["locationDetail"]
    if place:
        line += f" · {place}"
    if item["recurring"]:
        line += "（重复）"
    return line


def _searchable(row) -> str:
    if row is None:
        return ""
    return " ".join([
        row["title"] or "",
        row["location_name"] or "",
        row["location_address"] or "",
        row["location_detail"] or "",
        row["description"] or "",
    ]).lower()


def _preview(note: str) -> str:
    trimmed = note.strip()
    return trimmed if len(trimmed) <= NOTE_PREVIEW_LIMIT else trimmed[:NOTE_PREVIEW_LIMIT] + "…"


def _text(args: dict, field_name: str) -> str | None:
    value = args.get(field_name)
    if value is None or not isinstance(value, (str, int, float)):
        return None
    raw = str(value)
    return raw if raw.strip() else None


def _event_limit() -> int:
    from ..config import settings
    return settings.agent_event_limit
