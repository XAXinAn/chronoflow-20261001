"""关键字检索（spec §4.1.7 / §6.2 GET /search）。行为与 Java 版 SearchService 对齐。

三个容易做错的地方，这里都单独处理：

1. **不能只搜当前月份**：否则「搜上个月那个会」永远搜不到——服务端全量检索，不带时间范围；
2. **重复日程要给出「最近一次」**：命中的是一整条序列，直接回原始 start_at 会把用户带回几个月前，
   这里展开出下一次实例，连同 occurrenceDate 一起返回；
3. **关键字里的 % 和 _ 必须转义**：不转义就成了通配符，搜「50%」会命中所有日程。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode
from . import recurrence

TYPE_EVENT = "EVENT"
TYPE_TASK = "TASK"
DEFAULT_LIMIT = 20
MAX_LIMIT = 50
# 找「下一次实例」的展开窗口：跨两年，足够覆盖 YEARLY 规则
NEXT_OCCURRENCE_WINDOW = timedelta(days=730)

# ESCAPE '\' 是必须的：用户输入里的 % / _ 必须当字面量
_EVENT_SQL = text(
    "SELECT e.* FROM event e"
    " JOIN calendar c ON c.id = e.calendar_id"
    " WHERE c.owner_identity_id = :identity"
    " AND e.deleted_at IS NULL"
    " AND e.status <> 'CANCELLED'"
    " AND (e.title ILIKE :pattern ESCAPE '\\'"
    "      OR e.description ILIKE :pattern ESCAPE '\\'"
    "      OR e.location_name ILIKE :pattern ESCAPE '\\')"
    " ORDER BY e.start_at DESC"
    " LIMIT :limit"
)

# 已完成 / 已取消的待办也要返回：用户经常要回头找「上个月做掉的那件事」
_TASK_SQL = text(
    "SELECT t.* FROM task t"
    " WHERE t.owner_identity_id = :identity"
    " AND t.deleted_at IS NULL"
    " AND (t.title ILIKE :pattern ESCAPE '\\'"
    "      OR t.description ILIKE :pattern ESCAPE '\\')"
    " ORDER BY t.due_at DESC NULLS LAST"
    " LIMIT :limit"
)


def _like_pattern(keyword: str) -> str:
    escaped = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def parse_types(types: list[str] | None) -> set[str]:
    """`types=EVENT`、`types=EVENT,TASK`、`types=EVENT&types=TASK` 都接受。"""
    if not types:
        return {TYPE_EVENT, TYPE_TASK}
    wanted: set[str] = set()
    for raw in types:
        for part in str(raw).split(","):
            value = part.strip().upper()
            if not value:
                continue
            if value not in (TYPE_EVENT, TYPE_TASK):
                raise ApiError(ErrorCode.PARAM_INVALID, f"types 取值非法: {part.strip()}")
            wanted.add(value)
    return wanted or {TYPE_EVENT, TYPE_TASK}


def _sort_key(item: dict) -> tuple[int, float]:
    """排序键：时间倒序，无时间的排在最后。

    用「正负号 + 是否为空」两段式元组，比在 sort 里写比较函数更难出错。
    """
    at = item["startAt"] if item["type"] == TYPE_EVENT else item["dueAt"]
    if at is None:
        return (1, 0.0)
    return (0, -at.timestamp())


class SearchService:
    def __init__(self, session: Session):
        self._session = session

    def search(
        self,
        identity_id: int,
        keyword: str,
        types: list[str] | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        trimmed = (keyword or "").strip()
        if not trimmed:
            raise ApiError(ErrorCode.PARAM_INVALID, "检索关键字不能为空")

        wanted = parse_types(types)
        effective_limit = DEFAULT_LIMIT if limit is None else max(1, min(int(limit), MAX_LIMIT))
        pattern = _like_pattern(trimmed)

        items: list[dict] = []
        if TYPE_EVENT in wanted:
            items.extend(self._events(identity_id, pattern, effective_limit))
        if TYPE_TASK in wanted:
            items.extend(self._tasks(identity_id, pattern, effective_limit))

        items.sort(key=_sort_key)
        return items[:effective_limit]

    def _events(self, identity_id: int, pattern: str, limit: int) -> list[dict]:
        events = (
            self._session.execute(
                _EVENT_SQL, {"identity": identity_id, "pattern": pattern, "limit": limit}
            )
            .mappings()
            .all()
        )
        if not events:
            return []

        # 重复日程的例外一次性批量取出来：逐条查就是 N+1
        exceptions: dict[int, list[dict]] = {}
        for row in self._session.execute(
            text("SELECT * FROM event_exception WHERE event_id = ANY(:ids)"),
            {"ids": [row["id"] for row in events]},
        ).mappings():
            exceptions.setdefault(row["event_id"], []).append(dict(row))

        now = datetime.now(timezone.utc)
        return [
            self._event_item(dict(event), exceptions.get(event["id"], []), now) for event in events
        ]

    def _event_item(self, event: dict, exceptions: list[dict], now: datetime) -> dict:
        recurring = bool(event.get("rrule"))
        start = event["start_at"]
        end = event["end_at"]
        occurrence_date = None

        if recurring:
            upcoming = recurrence.expand(
                event, exceptions, now, now + NEXT_OCCURRENCE_WINDOW
            )
            if upcoming:
                first = upcoming[0]
                start = first["startAt"]
                end = first["endAt"]
                occurrence_date = first["occurrenceDate"]
            # 序列已经走完（rrule_until 已过）：退回序列起点、occurrenceDate 保持 null，
            # 让 App 打开整条序列而不是某个不存在的实例

        return {
            "type": TYPE_EVENT,
            "id": event["id"],
            "title": event["title"],
            "startAt": start,
            "endAt": end,
            "allDay": bool(event.get("all_day")),
            "timezone": event.get("timezone") or "UTC",
            "locationName": event.get("location_name"),
            "dueAt": None,
            "status": event["status"],
            "priority": event["priority"],
            "recurring": recurring,
            "occurrenceDate": occurrence_date,
        }

    def _tasks(self, identity_id: int, pattern: str, limit: int) -> list[dict]:
        rows = (
            self._session.execute(
                _TASK_SQL, {"identity": identity_id, "pattern": pattern, "limit": limit}
            )
            .mappings()
            .all()
        )
        return [
            {
                "type": TYPE_TASK,
                "id": row["id"],
                "title": row["title"],
                "startAt": None,
                "endAt": None,
                "allDay": bool(row["all_day"]),
                "timezone": None,
                "locationName": None,
                "dueAt": row["due_at"],
                "status": row["status"],
                "priority": row["priority"],
                "recurring": None,
                "occurrenceDate": None,
            }
            for row in rows
        ]
