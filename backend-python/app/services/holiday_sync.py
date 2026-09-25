"""节假日数据自动同步（spec §5.11）。行为与 Java 版 HolidaySyncService / Scheduler 对齐。

每天从 holiday-cn 拉当年与次年的放假安排，幂等 upsert 进 holiday 表并清缓存。
为什么要有它：放假安排每年都在变（还会中途更正调休），靠人记得去跑脚本迟早会漏；
数据只有几十条、上游一年动几次，每天跑一次的代价可以忽略，但能把「忘了更新」直接消掉。

几条刻意的设计（与 Java 版逐条对齐）：

1. **永不抛异常**：上游抖动不该影响服务本身，失败只记状态 + 告警，界面继续用库里已有的数据；
2. **先全解析再写库**：某一年格式变了就整年跳过，不写半截——半截数据比旧数据更难排查；
3. **次年是 404 属正常**：通知通常当年 11 月才发，没发布就跳过；
4. **同步完清缓存**：否则会变成「库里更新了、界面还是旧的」。
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from ..config import settings
from ..db import SessionLocal
from . import holiday

logger = logging.getLogger(__name__)

COUNTRY = "zh-CN"
ZONE = ZoneInfo("Asia/Shanghai")

_UPSERT = text(
    "INSERT INTO holiday (country_code, holiday_date, name, day_type)"
    " VALUES (:country, :date, :name, :day_type)"
    " ON CONFLICT (country_code, holiday_date)"
    " DO UPDATE SET name = EXCLUDED.name, day_type = EXCLUDED.day_type, updated_at = now()"
)

# 后台任务的运行状态。做成可读的：静默失败是排查噩梦（库里还是去年的数据，界面上看不出来）
_state: dict = {
    "lastRunAt": None,
    "lastSuccessAt": None,
    "lastError": None,
    "lastSyncedDays": 0,
    "years": [],
}


def status() -> dict:
    return {**_state, "enabled": settings.holiday_sync_enabled}


def _fetch(year: int) -> str | None:
    """取某年的上游 JSON 原文；返回 None 表示该年尚未发布（正常情况，不是错误）。"""
    url = f"{settings.holiday_sync_base_url.rstrip('/')}/{year}.json"
    try:
        with urllib.request.urlopen(url, timeout=settings.holiday_sync_timeout) as response:  # noqa: S310
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            logger.info("holiday-cn 还没有 %s 年的数据（尚未发布），本次跳过", year)
            return None
        raise


def _parse(raw: str, expected_year: int) -> list[tuple[date, str, str]]:
    """解析并**全量校验**，任何一条不合格就整年放弃（返回前不写库）。"""
    payload = json.loads(raw)
    declared = payload.get("year")
    if declared is not None and declared != expected_year:
        raise ValueError(f"上游返回的年份不匹配：{declared} ≠ {expected_year}")

    rows: list[tuple[date, str, str]] = []
    for item in payload.get("days") or []:
        date_text = item.get("date")
        name = str(item.get("name") or "").strip()
        if not date_text or not name:
            raise ValueError(f"上游数据缺少日期或名称：{item}")
        rows.append(
            (
                date.fromisoformat(str(date_text)),
                name,
                "HOLIDAY" if item.get("isOffDay") else "WORKDAY",
            )
        )
    return rows


def sync_once() -> None:
    """同步当年 + 次年。任何失败都只记录状态，不向外抛。"""
    now = datetime.now(ZONE)
    days = 0
    synced: list[int] = []
    failures: list[str] = []

    with SessionLocal() as session:
        for year in (now.year, now.year + 1):
            try:
                raw = _fetch(year)
                if raw is None:
                    continue
                rows = _parse(raw, year)
                if not rows:
                    # 上游会给次年先建一个 days 为空的占位文件，别把它算进「已同步」里自欺欺人
                    logger.info("%s 年的上游文件已存在但还没有放假安排，本次跳过", year)
                    continue
                for day, name, day_type in rows:
                    session.execute(
                        _UPSERT,
                        {"country": COUNTRY, "date": day, "name": name, "day_type": day_type},
                    )
                # 每年单独提交：次年的格式变了不该把当年的更正一起回滚
                session.commit()
                days += len(rows)
                synced.append(year)
            except Exception as exc:  # noqa: BLE001 - 后台任务不该因上游异常而崩
                failures.append(f"{year} 年：{exc}")
                logger.warning("同步 %s 年节假日失败：%s", year, exc)

    # 清缓存是必须的：否则库里更新了、界面还要等一个 TTL 才变，看起来就是「同步没生效」
    holiday.clear_cache()

    _state["lastRunAt"] = now.isoformat()
    if failures:
        _state["lastError"] = "；".join(failures)
    else:
        _state.update(
            {
                "lastSuccessAt": now.isoformat(),
                "lastError": None,
                "lastSyncedDays": days,
                "years": synced,
            }
        )
        logger.info("节假日同步完成：写入/更新 %s 条（%s）", days, synced)


def seconds_until_next_run(now: datetime | None = None) -> float:
    """距下一次每日同步的秒数。默认 03:10（东八区），与 Java 版 cron 对齐。"""
    current = now or datetime.now(ZONE)
    target = current.replace(
        hour=settings.holiday_sync_hour, minute=settings.holiday_sync_minute, second=0, microsecond=0
    )
    if target <= current:
        target += timedelta(days=1)
    return (target - current).total_seconds()


async def run_forever() -> None:
    """后台循环：启动后补跑一次，然后每天定时跑。由 lifespan 启动、随应用关闭而取消。"""
    if settings.holiday_sync_run_on_startup:
        # 不阻塞启动：等一小会儿再跑（顺带避开启动瞬间的资源竞争）
        await asyncio.sleep(settings.holiday_sync_startup_delay)
        await asyncio.to_thread(sync_once)

    while True:
        await asyncio.sleep(seconds_until_next_run())
        await asyncio.to_thread(sync_once)
