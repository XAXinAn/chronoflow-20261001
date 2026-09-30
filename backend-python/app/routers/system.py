from __future__ import annotations

import os

from fastapi import APIRouter

from ..errors import envelope

router = APIRouter(prefix="/api/v1/system", tags=["system"])


@router.get("/info")
def info() -> dict:
    from ..services.geo import GeoService
    from ..services.holiday_sync import status as holiday_sync_status
    from ..services import agent_model

    geo = GeoService()
    return envelope(
        {
            "name": os.getenv("APP_NAME", "xa-todo-backend"),
            "version": os.getenv("XATODO_VERSION", "0.1.0"),
            "serverTime": None,
            # 地图能力随配置变化；客户端据此决定是否展示地图入口（spec §5.9）
            "geoProvider": geo.provider_name,
            "geoDegraded": geo.degraded,
            # 小安（智能助手）是否已接入模型（spec §11 阶段三）。App 读到缺失或 false
            # 就保持「还没有接入模型」的提示，而不是让用户对着输入框等一个永远不来的回答。
            "aiAgentEnabled": agent_model.client().available(),
            # 节假日自动同步状态（spec §5.11）：后台任务静默失败时，这里能看出来
            "holidaySync": holiday_sync_status(),
        }
    )


@router.get("/ping")
def ping() -> dict:
    return envelope("pong")
