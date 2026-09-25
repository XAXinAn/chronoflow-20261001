from __future__ import annotations

import os

from fastapi import APIRouter

from ..errors import envelope

router = APIRouter(prefix="/api/v1/system", tags=["system"])


@router.get("/info")
def info() -> dict:
    from ..services.geo import GeoService
    from ..services.holiday_sync import status as holiday_sync_status

    geo = GeoService()
    return envelope(
        {
            "name": os.getenv("APP_NAME", "xa-todo-backend"),
            "version": os.getenv("XATODO_VERSION", "0.1.0"),
            "serverTime": None,
            # 地图能力随配置变化；客户端据此决定是否展示地图入口（spec §5.9）
            "geoProvider": geo.provider_name,
            "geoDegraded": geo.degraded,
            # 节假日自动同步状态（spec §5.11）：后台任务静默失败时，这里能看出来
            "holidaySync": holiday_sync_status(),
        }
    )


@router.get("/ping")
def ping() -> dict:
    return envelope("pong")
