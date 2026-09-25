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
#: 组织下发给我的组织日程：跨组织一起搜，点开要跳到它所属的组织视图（spec §4.1.7）
TYPE_ORG_EVENT = "ORG_EVENT"
ALL_TYPES = (TYPE_EVENT, TYPE_TASK, TYPE_ORG_EVENT)
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

# 我绑定过的**所有组织**下发给我的组织日程。三条过滤都不能少：
#   1) i.account_id + i.status='ACTIVE'：只搜当前账号当前有效的组织身份；
#   2) m.status='ACTIVE'：已离职/停用的成员不再看到组织日程；
#   3) d.status='ACTIVE'：**撤回过的下发不出现**，否则用户会搜到一个点开就没了的活动。
_ORG_EVENT_SQL = text(
    "SELECT DISTINCT e.id AS event_id, i.id AS identity_id, o.id AS org_id, o.name AS org_name"
    " FROM event_recipient r"
    " JOIN org_member m ON m.id = r.org_member_id"
    " JOIN identity i ON i.id = m.identity_id"
    " JOIN event_dispatch d ON d.id = r.dispatch_id"
    " JOIN event e ON e.id = r.event_id"
    " JOIN organization o ON o.id = i.org_id"
    " WHERE i.account_id = :account"
    " AND i.identity_type = 'ORG_MEMBER' AND i.status = 'ACTIVE'"
    " AND m.status = 'ACTIVE'"
    " AND d.status = 'ACTIVE'"
    " AND e.deleted_at IS NULL AND e.status <> 'CANCELLED'"
    " AND o.deleted_at IS NULL"
    " AND (e.title ILIKE :pattern ESCAPE '\\'"
    "      OR e.description ILIKE :pattern ESCAPE '\\'"
    "      OR e.location_name ILIKE :pattern ESCAPE '\\')"
    " ORDER BY e.id DESC"
    " LIMIT :limit"
)


def _like_pattern(keyword: str) -> str:
    escaped = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def parse_types(types: list[str] | None) -> set[str]:
    """`types=EVENT`、`types=EVENT,TASK`、`types=EVENT&types=TASK` 都接受。"""
    if not types:
        return set(ALL_TYPES)
    wanted: set[str] = set()
    for raw in types:
        for part in str(raw).split(","):
            value = part.strip().upper()
            if not value:
                continue
            if value not in ALL_TYPES:
                raise ApiError(ErrorCode.PARAM_INVALID, f"types 取值非法: {part.strip()}")
            wanted.add(value)
    return wanted or set(ALL_TYPES)


def _sort_key(item: dict) -> tuple[int, float]:
    """排序键：时间倒序，无时间的排在最后。

    用「正负号 + 是否为空」两段式元组，比在 sort 里写比较函数更难出错。
    """
    # 待办取截止时间，日程（个人 / 组织）取开始时间
    at = item["dueAt"] if item["type"] == TYPE_TASK else item["startAt"]
    if at is None:
        return (1, 0.0)
    return (0, -at.timestamp())


class SearchService:
    def __init__(self, session: Session):
        self._session = session

    def search(
        self,
        identity_id: int,
        account_id: int,
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
        if TYPE_ORG_EVENT in wanted:
            # 组织日程按**账号**搜：一个人可以绑多个组织，跨组织一起给结果
            items.extend(self._org_events(account_id, pattern, effective_limit))

        items.sort(key=_sort_key)
        return items[:effective_limit]

    def _org_events(self, account_id: int, pattern: str, limit: int) -> list[dict]:
        """我绑定过的所有组织下发给我的组织日程（spec §4.1.7）。"""
        hits = (
            self._session.execute(
                _ORG_EVENT_SQL, {"account": account_id, "pattern": pattern, "limit": limit}
            )
            .mappings()
            .all()
        )
        if not hits:
            return []

        # 同一个日程可能被多次下发给我：按事件去重，保留第一次命中的身份/组织
        refs: dict[int, dict] = {}
        for hit in hits:
            refs.setdefault(hit["event_id"], dict(hit))

        events = (
            self._session.execute(
                text(
                    "SELECT * FROM event WHERE id = ANY(:ids)"
                    " AND deleted_at IS NULL AND status <> 'CANCELLED'"
                ),
                {"ids": list(refs)},
            )
            .mappings()
            .all()
        )
        if not events:
            return []

        exceptions: dict[int, list[dict]] = {}
        for row in self._session.execute(
            text("SELECT * FROM event_exception WHERE event_id = ANY(:ids)"),
            {"ids": [row["id"] for row in events]},
        ).mappings():
            exceptions.setdefault(row["event_id"], []).append(dict(row))

        now = datetime.now(timezone.utc)
        items: list[dict] = []
        for event in events:
            event_id = event["id"]
            ref = refs[event_id]
            start, end, occurrence_date = self._resolve_occurrence(
                dict(event), exceptions.get(event_id, []), now
            )
            items.append(
                {
                    "type": TYPE_ORG_EVENT,
                    "id": event_id,
                    "title": event["title"],
                    "startAt": start,
                    "endAt": end,
                    "allDay": bool(event["all_day"]),
                    "timezone": event["timezone"] or "UTC",
                    "locationName": event["location_name"],
                    "dueAt": None,
                    "status": event["status"],
                    "priority": event["priority"],
                    "recurring": bool(event["rrule"]),
                    "occurrenceDate": occurrence_date,
                    # 组织日程是只读的：App 点开要切到这个组织的视图，而不是个人日程编辑页
                    "identityId": ref["identity_id"],
                    "orgId": ref["org_id"],
                    "orgName": ref["org_name"],
                }
            )
        return items

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
        start, end, occurrence_date = self._resolve_occurrence(event, exceptions, now)

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
            "identityId": None,
            "orgId": None,
            "orgName": None,
        }

    @staticmethod
    def _resolve_occurrence(
        event: dict, exceptions: list[dict], now: datetime
    ) -> tuple[datetime, datetime, object]:
        """命中时间：重复日程给出**最近一次实例**，非重复用自己的起止时间。

        序列已经走完（rrule_until 已过）时退回序列起点、occurrenceDate 留空，
        让 App 打开整条序列而不是某个不存在的实例。
        """
        if not event.get("rrule"):
            return event["start_at"], event["end_at"], None
        upcoming = recurrence.expand(event, exceptions, now, now + NEXT_OCCURRENCE_WINDOW)
        if not upcoming:
            return event["start_at"], event["end_at"], None
        first = upcoming[0]
        return first["startAt"], first["endAt"], first["occurrenceDate"]

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
                "identityId": None,
                "orgId": None,
                "orgName": None,
            }
            for row in rows
        ]
