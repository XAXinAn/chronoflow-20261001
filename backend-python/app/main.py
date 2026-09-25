"""FastAPI 应用入口。

与 Java 版共享：同一份 PostgreSQL schema（由 Flyway 管理）、同一 Redis 键规范、
同一 JWT 密钥与 claim 结构、同一响应体与错误码。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import bcrypt
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .errors import ApiError, ErrorCode, envelope, set_trace_id
from .routers import admin, auth, geo, me, org, personal, support, system
from .config import settings
from .services import holiday_sync

logger = logging.getLogger(__name__)


def bootstrap_super_admin() -> None:
    """首次启动且 admin_user 表为空时创建初始超管。

    与 Java 版 AdminUserInitializer 行为一致——否则会出现「没有任何人能登录后台」的死锁状态。
    生产环境务必用环境变量覆盖初始密码。
    """
    from .db import SessionLocal

    username = os.getenv("ADMIN_BOOTSTRAP_USERNAME", "admin")
    password = os.getenv("ADMIN_BOOTSTRAP_PASSWORD", "admin123456")
    with SessionLocal() as session:
        if session.execute(text("SELECT count(*) FROM admin_user")).scalar_one():
            return
        session.execute(
            text(
                "INSERT INTO admin_user (username, password_hash, real_name, role, mfa_enabled,"
                " status, failed_login_count)"
                " VALUES (:username, :hash, '平台超管', 'SUPER_ADMIN', false, 'ACTIVE', 0)"
            ),
            {
                "username": username,
                "hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode(),
            },
        )
        session.commit()
        logger.warning("已创建初始超级管理员 [%s]，请立即登录后台修改密码", username)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap_super_admin()
    # 节假日数据每天自动同步一次（spec §5.11）。测试里用 HOLIDAY_SYNC_ENABLED=false 关掉：
    # 单元测试不该依赖外网。
    sync_task = None
    if settings.holiday_sync_enabled:
        sync_task = asyncio.create_task(holiday_sync.run_forever())
    try:
        yield
    finally:
        if sync_task is not None:
            sync_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sync_task

app = FastAPI(
    title="XaTodo API（Python 版）",
    description="心安待办后端。对外契约与 Java 版一致，见 contract/api-contract.json。",
    version="0.1.0",
    # 与 Java 版 springdoc 的路径保持一致，便于互换部署与统一文档入口
    openapi_url="/v3/api-docs",
    docs_url="/swagger-ui.html",
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def trace_id_middleware(request: Request, call_next):
    trace_id = request.headers.get("X-Trace-Id") or str(uuid.uuid4())
    set_trace_id(trace_id)
    response = await call_next(request)
    response.headers["X-Trace-Id"] = trace_id
    return response


@app.exception_handler(ApiError)
async def handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status, content=envelope(None, int(exc.code), exc.message)
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    detail = "; ".join(
        f"{'.'.join(str(part) for part in error.get('loc', []))}: {error.get('msg')}"
        for error in exc.errors()
    )
    return JSONResponse(
        status_code=400,
        content=envelope(None, int(ErrorCode.PARAM_INVALID), detail or "参数格式错误"),
    )


@app.exception_handler(Exception)
async def handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500, content=envelope(None, int(ErrorCode.INTERNAL_ERROR), "服务内部错误")
    )


app.include_router(system.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(personal.router)
app.include_router(org.router)
app.include_router(admin.router)
app.include_router(geo.router)
app.include_router(support.router)

# 上传目录映射成 /uploads/**（spec §5.10）。
# 必须免鉴权：<Image> 直接按 URL 取图，带不了 Authorization 头——
# 代价是这里不能放任何私有内容，只有头像与反馈图片走这条路。
_upload_dir = Path(os.getenv("XATODO_UPLOAD_DIR", "./data/uploads")).resolve()
_upload_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_upload_dir), name="uploads")
