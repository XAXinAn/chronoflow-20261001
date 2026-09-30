"""重复日程展开（spec §4.1.2）。

行为与 Java 版 RecurrenceExpander 对齐，两个要点：

1. **按事件自身时区展开**：「每周一 09:00（Asia/Shanghai）」必须落在当地周一上午。
2. **timestamptz 微秒精度**：`scope=FUTURE` 截断序列时退让量必须大于数据库精度
   （PostgreSQL 只存到微秒），Java 侧曾因退让 1 纳秒被四舍五入而截断失效。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr

from ..errors import ApiError, ErrorCode

MAX_OCCURRENCES = 10_000

# 截断退让量：必须大于 timestamptz 的微秒精度，否则会被四舍五入回原时刻
TRUNCATE_MARGIN = timedelta(milliseconds=1)


def resolve_zone(timezone: str | None) -> ZoneInfo:
    if not timezone:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(timezone)
    except Exception:  # noqa: BLE001 - 非法时区回退到 UTC，与 Java 版一致
        return ZoneInfo("UTC")


def validate_rrule(rule_text: str | None) -> None:
    if not rule_text:
        return
    try:
        rrulestr(rule_text, dtstart=datetime(2026, 1, 1, tzinfo=ZoneInfo("UTC")))
    except Exception as exc:  # noqa: BLE001
        raise ApiError(ErrorCode.RRULE_INVALID, f"重复规则无法解析: {rule_text}") from exc


def expand(event: dict, exceptions: list[dict], range_start: datetime, range_end: datetime) -> list[dict]:
    """展开日程在 [range_start, range_end) 内的实例，按时间升序。

    日程只有一个**时间点**（spec §4.1.2）：一次出现就是那一刻，
    落在窗口里就算命中（`range_start <= at < range_end`）。
    """
    zone = resolve_zone(event.get("timezone"))
    at: datetime = event["at"]

    if not event.get("rrule"):
        if range_start <= at < range_end:
            return [_occurrence(event, at, None, False)]
        return []

    by_date = {row["occurrence_date"]: row for row in exceptions}
    hard_stop = range_end
    if event.get("rrule_until"):
        hard_stop = min(hard_stop, event["rrule_until"])

    start_local = at.astimezone(zone)
    try:
        rule = rrulestr(event["rrule"], dtstart=start_local)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(ErrorCode.RRULE_INVALID, f"重复规则无法解析: {event['rrule']}") from exc

    results: list[dict] = []
    for index, occurrence in enumerate(rule):
        if index >= MAX_OCCURRENCES:
            break
        occurrence_start = occurrence.astimezone(zone)
        if occurrence_start > hard_stop:
            break

        occurrence_date = occurrence_start.date()
        exception = by_date.get(occurrence_date)
        if exception and exception["exception_type"] == "CANCELLED":
            continue

        modified = bool(exception and exception["exception_type"] == "MODIFIED")
        effective_at = (
            exception["override_at"]
            if modified and exception.get("override_at")
            else occurrence_start
        )
        title = (
            exception["override_title"]
            if modified and exception.get("override_title")
            else event["title"]
        )

        if not (range_start <= effective_at < range_end):
            continue

        results.append(_occurrence(event, effective_at, occurrence_date, modified, title))

    results.sort(key=lambda item: (item["at"], item["eventId"]))
    return results


def occurrence_start(event: dict, occurrence_date) -> datetime:
    """由本地日期还原该次出现的开始时刻（用于 THIS / FUTURE 定位）。"""
    zone = resolve_zone(event.get("timezone"))
    local = event["at"].astimezone(zone)
    return datetime.combine(occurrence_date, local.time(), tzinfo=zone)


def _occurrence(
    event: dict,
    at: datetime,
    occurrence_date,
    modified: bool,
    title: str | None = None,
) -> dict:
    return {
        "eventId": event["id"],
        "calendarId": event["calendar_id"],
        "title": title if title is not None else event["title"],
        # 地点已结构化（spec §5.9）：实例同样带名称与地址，与 Java 版 EventOccurrence 对齐
        "locationName": event.get("location_name"),
        "locationDetail": event.get("location_detail"),
        "locationAddress": event.get("location_address"),
        "at": at,
        "timezone": event.get("timezone"),
        "recurring": bool(event.get("rrule")),
        "occurrenceDate": occurrence_date,
        "modified": modified,
    }
