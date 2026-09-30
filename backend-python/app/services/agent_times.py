"""解析模型给的时间字符串（对照 Java 版 `AgentTimes`）。

模型给的形式很杂：带偏移量的完整时间、不带偏移量的「日期 时间」、只有日期
（视为「就这一天」）、以及纯数字时间戳。「明天下午三点」这种相对时间不在这里算，
靠系统提示里的「今天是几号」让模型自己换算成绝对时间。

实在解析不了就返回 None，由调用方决定是「先问用户」还是当参数非法。
"""

from __future__ import annotations

from datetime import datetime, timezone as dt_timezone
from zoneinfo import ZoneInfo


def parse(raw: str | None, zone: ZoneInfo) -> datetime | None:
    if raw is None or not raw.strip():
        return None
    value = raw.strip()

    # 带偏移量的完整时间，或「日期 时间」/「只有日期」——Python 3.11 的 fromisoformat
    # 这几类都能吃下，吃不下时返回的仍是 naive 对象，下面统一按本地时区解释
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        parsed = None
    if parsed is not None:
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=zone)

    # 纯数字时间戳（有些模型会这么返回）
    try:
        return datetime.fromtimestamp(int(value), tz=dt_timezone.utc).astimezone(zone)
    except (ValueError, OSError, OverflowError):
        return None


def format_short(at: datetime, zone: ZoneInfo) -> str:
    """给人看的短时间：9/28 15:00。"""
    local = at.astimezone(zone)
    return f"{local.month}/{local.day} {local.hour:02d}:{local.minute:02d}"


def format_point(at: datetime, zone: ZoneInfo) -> str:
    """单时间点的展示。

    落在当地 00:00 的表示「只说了哪天、没说几点」（spec §4.1.2），只给日期；
    其余给「9/28 15:00」。**没有「全天」这个词**——那本来是我们自己造的概念。
    """
    local = at.astimezone(zone)
    if local.hour == 0 and local.minute == 0:
        return f"{local.month}/{local.day}"
    return format_short(at, zone)


def iso(at: datetime, zone: ZoneInfo) -> str:
    """给模型看的时间：带偏移量，原样带回时不会歧义。"""
    return at.astimezone(zone).isoformat()
