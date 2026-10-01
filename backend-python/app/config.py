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
    holiday_cache_ttl: int
    # 推送（spec §4.5）：app_key 公开、master_secret 仅服务端；为空时降级为「未配置」
    jpush_app_key: str
    jpush_master_secret: str
    jpush_base_url: str
    jpush_apns_production: bool
    holiday_sync_enabled: bool
    holiday_sync_base_url: str
    holiday_sync_hour: int
    holiday_sync_minute: int
    holiday_sync_run_on_startup: bool
    holiday_sync_startup_delay: float
    holiday_sync_timeout: float
    vision_base_url: str
    vision_model: str
    vision_api_key: str
    vision_timeout: float
    vision_structured_output: str
    vision_max_attempts: int
    # 智能助手「小安」（spec §11 阶段三）。环境变量名与 Java 版一字不差，
    # 两版可以指向同一个模型、共用同一份 .env。
    agent_base_url: str
    agent_api_key: str
    agent_model: str
    agent_enable_thinking: bool
    agent_max_tokens: int
    agent_timeout: float
    agent_max_tool_rounds: int
    agent_max_history_messages: int
    agent_event_limit: int
    agent_timezone: str
    agent_asr_url: str
    agent_asr_api_key: str
    agent_asr_model: str
    agent_asr_timeout: float
    agent_asr_language: str
    agent_asr_max_bytes: int


def load_settings() -> Settings:
    return Settings(
        database_url=os.getenv(
            "DATABASE_URL", "postgresql+psycopg://chronoflow:chronoflow@localhost:5432/chronoflow"
        ),
        redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
        # 与 Java 版同源：两边用同一密钥与 claim 结构，令牌可互换
        jwt_secret=os.getenv(
            "JWT_SECRET", "chronoflow-development-secret-key-change-me-in-production"
        ),
        jwt_issuer=os.getenv("JWT_ISSUER", "chronoflow"),
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
        # 节假日（spec §5.11）。环境变量名与 Java 版保持一致，两版可共用同一份配置。
        holiday_cache_ttl=_int("HOLIDAY_CACHE_TTL_SECONDS", 300),
        jpush_app_key=os.getenv("JPUSH_APPKEY", ""),
        jpush_master_secret=os.getenv("JPUSH_MASTER_SECRET", ""),
        jpush_base_url=os.getenv("JPUSH_BASE_URL", "https://api.jpush.cn"),
        jpush_apns_production=_bool("JPUSH_APNS_PRODUCTION", True),
        holiday_sync_enabled=_bool("HOLIDAY_SYNC_ENABLED", True),
        holiday_sync_base_url=os.getenv(
            "HOLIDAY_SYNC_BASE_URL",
            "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master",
        ),
        # 每天 03:10（东八区）同步，与 Java 版默认 cron 对齐
        holiday_sync_hour=_int("HOLIDAY_SYNC_HOUR", 3),
        holiday_sync_minute=_int("HOLIDAY_SYNC_MINUTE", 10),
        holiday_sync_run_on_startup=_bool("HOLIDAY_SYNC_RUN_ON_STARTUP", True),
        holiday_sync_startup_delay=float(os.getenv("HOLIDAY_SYNC_STARTUP_DELAY", "30")),
        holiday_sync_timeout=float(os.getenv("HOLIDAY_SYNC_TIMEOUT", "15")),
        # 本地轻量多模态识别（spec §4.1.9）。指向本机/内网的 OpenAI 兼容推理服务，
        # 留空表示未接入：那时 /ai/events/recognize 返回 90002，App 会明说「识别未接入」。
        vision_base_url=os.getenv("CHRONOFLOW_VISION_BASE_URL", ""),
        vision_model=os.getenv("CHRONOFLOW_VISION_MODEL", ""),
        vision_api_key=os.getenv("CHRONOFLOW_VISION_API_KEY", ""),
        vision_timeout=float(os.getenv("CHRONOFLOW_VISION_TIMEOUT_SECONDS", "60")),
        # json_object（支持面最广）/ json_schema（约束最强）/ none（只靠提示词，排查用）
        vision_structured_output=os.getenv("CHRONOFLOW_VISION_STRUCTURED_OUTPUT", "json_object"),
        vision_max_attempts=_int("CHRONOFLOW_VISION_MAX_ATTEMPTS", 2),
        # 智能助手「小安」（spec §11 阶段三）。api-key 留空 = 未接入：
        # /ai/agent/chat 直接返回 90002，/system/info 的 aiAgentEnabled=false。
        agent_base_url=os.getenv(
            "CHRONOFLOW_AGENT_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
        ),
        agent_api_key=os.getenv("CHRONOFLOW_AGENT_API_KEY", ""),
        agent_model=os.getenv("CHRONOFLOW_AGENT_MODEL", "qwen3.6-flash"),
        agent_enable_thinking=_bool("CHRONOFLOW_AGENT_ENABLE_THINKING", False),
        agent_max_tokens=_int("CHRONOFLOW_AGENT_MAX_TOKENS", 600),
        agent_timeout=float(os.getenv("CHRONOFLOW_AGENT_TIMEOUT_SECONDS", "90")),
        agent_max_tool_rounds=_int("CHRONOFLOW_AGENT_MAX_TOOL_ROUNDS", 4),
        agent_max_history_messages=_int("CHRONOFLOW_AGENT_MAX_HISTORY_MESSAGES", 10),
        agent_event_limit=_int("CHRONOFLOW_AGENT_EVENT_LIMIT", 20),
        # 解释「明天下午三点」这类相对时间用的时区，与 Java 版一致
        agent_timezone=os.getenv("CHRONOFLOW_AGENT_TIMEZONE", "Asia/Shanghai"),
        agent_asr_url=os.getenv(
            "CHRONOFLOW_ASR_URL",
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        ),
        agent_asr_api_key=os.getenv("CHRONOFLOW_ASR_API_KEY", ""),
        agent_asr_model=os.getenv("CHRONOFLOW_ASR_MODEL", "qwen3-asr-flash"),
        agent_asr_timeout=float(os.getenv("CHRONOFLOW_ASR_TIMEOUT_SECONDS", "60")),
        agent_asr_language=os.getenv("CHRONOFLOW_ASR_LANGUAGE", ""),
        # 录音上限 60 秒，正常也就几百 KB；超了多半是传错了文件
        agent_asr_max_bytes=_int("CHRONOFLOW_ASR_MAX_BYTES", 5 * 1024 * 1024),
    )


settings = load_settings()
