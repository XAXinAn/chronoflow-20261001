"""运行配置。默认值与 Java 版 application.yml 保持一致，便于本地互换部署。"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    return int(raw) if raw else default


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    jwt_secret: str
    jwt_issuer: str
    access_token_ttl: int
    refresh_token_ttl: int
    refresh_rotation_grace: int
    register_token_ttl: int
    select_token_ttl: int
    sms_code_ttl: int
    sms_send_interval: int
    sms_daily_limit_per_phone: int
    sms_daily_limit_per_ip: int
    sms_max_verify_attempts: int
    max_devices_per_identity: int
    expose_sms_code: bool
    geo_provider: str
    amap_key: str
    amap_js_key: str
    amap_js_security_code: str
    amap_base_url: str
    amap_timeout: float


def load_settings() -> Settings:
    return Settings(
        database_url=os.getenv(
            "DATABASE_URL", "postgresql+psycopg://xatodo:xatodo@localhost:5432/xatodo"
        ),
        redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
        # 与 Java 版同源：两边用同一密钥与 claim 结构，令牌可互换
        jwt_secret=os.getenv(
            "JWT_SECRET", "xa-todo-development-secret-key-change-me-in-production"
        ),
        jwt_issuer=os.getenv("JWT_ISSUER", "xa-todo"),
        access_token_ttl=_int("ACCESS_TOKEN_TTL", 2 * 60 * 60),
        refresh_token_ttl=_int("REFRESH_TOKEN_TTL", 90 * 24 * 60 * 60),
        refresh_rotation_grace=_int("REFRESH_ROTATION_GRACE", 60),
        register_token_ttl=_int("REGISTER_TOKEN_TTL", 30 * 60),
        select_token_ttl=_int("SELECT_TOKEN_TTL", 30 * 60),
        sms_code_ttl=_int("SMS_CODE_TTL", 5 * 60),
        sms_send_interval=_int("SMS_SEND_INTERVAL", 60),
        sms_daily_limit_per_phone=_int("SMS_DAILY_LIMIT_PER_PHONE", 10),
        sms_daily_limit_per_ip=_int("SMS_DAILY_LIMIT_PER_IP", 30),
        sms_max_verify_attempts=_int("SMS_MAX_VERIFY_ATTEMPTS", 5),
        max_devices_per_identity=_int("MAX_DEVICES_PER_IDENTITY", 5),
        # 生产环境必须为 false；无短信通道时仅开发/测试开启
        expose_sms_code=_bool("EXPOSE_SMS_CODE", False),
        # 地点服务（spec §5.9）。与 Java 版同名环境变量，两边可共用同一份配置。
        # 没配 Key 时服务层自动降级到内置地点集，保证离线环境与 CI 也能跑通全流程。
        geo_provider=os.getenv("GEO_PROVIDER", "amap"),
        amap_key=os.getenv("GEO_AMAP_KEY", ""),
        amap_js_key=os.getenv("GEO_AMAP_JS_KEY", ""),
        amap_js_security_code=os.getenv("GEO_AMAP_JS_SECURITY_CODE", ""),
        amap_base_url=os.getenv("GEO_AMAP_BASE_URL", "https://restapi.amap.com"),
        amap_timeout=float(os.getenv("GEO_AMAP_TIMEOUT_SECONDS", "5")),
    )


settings = load_settings()
