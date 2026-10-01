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
            "name": os.getenv("APP_NAME", "chronoflow-backend"),
            "version": os.getenv("CHRONOFLOW_VERSION", "0.1.0"),
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


def _app_release() -> dict:
    """App 新版本发布信息（spec §4.1.11）。**免登录**：登录接口改坏时老客户端也要能升级。

    与 Java 版同一形状、同一语义：`versionCode <= 0` 或没配包地址 = 这个部署不提供
    应用内更新，回一个 0 版本号而不是编一个。发布信息全部来自环境变量。
    """
    version_code = int(os.getenv("CHRONOFLOW_APP_RELEASE_VERSION_CODE", "0") or 0)
    apk_url = os.getenv("CHRONOFLOW_APP_RELEASE_APK_URL", "").strip()
    if version_code <= 0 or not apk_url:
        return {
            "versionName": None,
            "versionCode": 0,
            "apkUrl": None,
            "sizeBytes": 0,
            "sha256": None,
            "changelog": [],
            "force": False,
            "minSupportedVersionCode": 0,
            "publishedAt": None,
        }
    version_name = os.getenv("CHRONOFLOW_APP_RELEASE_VERSION_NAME", "").strip() or str(version_code)
    # 更新说明用 `|` 分隔多条：环境变量里写不了列表，这是最省事又不会歧义的写法
    changelog = [
        part.strip()
        for part in os.getenv("CHRONOFLOW_APP_RELEASE_CHANGELOG", "").split("|")
        if part.strip()
    ]
    return {
        "versionName": version_name,
        "versionCode": version_code,
        "apkUrl": apk_url,
        "sizeBytes": int(os.getenv("CHRONOFLOW_APP_RELEASE_SIZE_BYTES", "0") or 0),
        "sha256": os.getenv("CHRONOFLOW_APP_RELEASE_SHA256", "").strip() or None,
        "changelog": changelog,
        "force": os.getenv("CHRONOFLOW_APP_RELEASE_FORCE", "false").strip().lower() in ("1", "true", "yes"),
        "minSupportedVersionCode": int(
            os.getenv("CHRONOFLOW_APP_RELEASE_MIN_SUPPORTED_VERSION_CODE", "0") or 0),
        "publishedAt": os.getenv("CHRONOFLOW_APP_RELEASE_PUBLISHED_AT", "").strip() or None,
    }


@router.get("/app-release")
def app_release() -> dict:
    return envelope(_app_release())
