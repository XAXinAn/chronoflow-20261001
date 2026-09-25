"""节假日与调休（spec §5.11）。行为与 Java 版 HolidayService 对齐。

数据全在 holiday 表里，由 scripts/load_holidays.py 灌入；这里只负责读与缓存。
数据刻意不进 Flyway 迁移、不进代码：换一年、按官方通知更正一个调休日都只是重跑脚本，
不用发版、不用重启——进程内缓存最多陈旧一个 TTL。
"""

from __future__ import annotations

import os
import threading
import time
from datetime import date

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import ApiError, ErrorCode

DEFAULT_COUNTRY = "zh-CN"
MIN_YEAR = 1970
MAX_YEAR = 2100
DEFAULT_TTL_SECONDS = 300


def _ttl_seconds() -> float:
    """缓存时长可用 HOLIDAY_CACHE_TTL_SECONDS 覆盖（与 Java 版 cache-ttl 对应）。"""
    raw = os.getenv("HOLIDAY_CACHE_TTL_SECONDS")
    if not raw:
        return DEFAULT_TTL_SECONDS
    try:
        return max(1.0, float(raw))
    except ValueError:
        # 配错了不该让接口挂掉：退回默认值继续服务
        return DEFAULT_TTL_SECONDS


class _TtlCache:
    """进程内 TTL 缓存。

    FastAPI 的同步接口跑在线程池里，所以这里必须加锁：不加锁的话，
    两个并发请求同时写同一个 key 是小事，读到半更新的 dict 才是麻烦。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, dict]] = {}

    def get(self, key: str) -> dict | None:
        with self._lock:
            hit = self._entries.get(key)
            if hit is None:
                return None
            expires_at, value = hit
            if expires_at <= time.monotonic():
                self._entries.pop(key, None)
                return None
            return dict(value)

    def put(self, key: str, value: dict) -> None:
        with self._lock:
            self._entries[key] = (time.monotonic() + _ttl_seconds(), dict(value))

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_cache = _TtlCache()


def clear_cache() -> None:
    """数据热更新后想立刻生效可以调它；不调也行，最多等一个 TTL。"""
    _cache.clear()


def normalize_country(country: str | None) -> str:
    """国家日历标识归一化：`zh-cn`、`ZH-CN` 都当 `zh-CN`，避免大小写不同查不到数据。"""
    if country is None or not country.strip():
        return DEFAULT_COUNTRY
    trimmed = country.strip()
    language, _, region = trimmed.partition("-")
    if not language or not region:
        raise ApiError(ErrorCode.PARAM_INVALID, "country 需形如 zh-CN")
    return f"{language.lower()}-{region.upper()}"


class HolidayService:
    def __init__(self, session: Session):
        self._session = session

    def query(self, country: str | None, year: int | None, month: int | None) -> dict:
        if year is None:
            raise ApiError(ErrorCode.PARAM_INVALID, "year 不能为空")
        if year < MIN_YEAR or year > MAX_YEAR:
            raise ApiError(ErrorCode.PARAM_INVALID, "year 超出有效范围")
        if month is not None and (month < 1 or month > 12):
            raise ApiError(ErrorCode.PARAM_INVALID, "month 必须在 1-12 之间")
        normalized = normalize_country(country)

        key = f"{normalized}|{year}|{month if month else 'all'}"
        cached = _cache.get(key)
        if cached is not None:
            return cached

        # 半开区间 [from, to)：`< 次年 1 月 1 日` 比 `<= 12-31` 更不容易在跨年时写错一天
        from_date = date(year, 1, 1) if month is None else date(year, month, 1)
        to_date = date(year + 1, 1, 1) if month is None else date(year + (month // 12), month % 12 + 1, 1)

        rows = (
            self._session.execute(
                text(
                    "SELECT holiday_date, name, day_type FROM holiday"
                    " WHERE country_code = :country"
                    " AND holiday_date >= :from_date AND holiday_date < :to_date"
                    " ORDER BY holiday_date"
                ),
                {"country": normalized, "from_date": from_date, "to_date": to_date},
            )
            .mappings()
            .all()
        )
        response = {
            "country": normalized,
            "year": year,
            "month": month,
            "days": [
                {"date": row["holiday_date"], "name": row["name"], "dayType": row["day_type"]}
                for row in rows
            ],
        }
        _cache.put(key, response)
        return response
