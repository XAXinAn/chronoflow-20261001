"""拍照 / 相册 → 日程草稿（spec §4.1.9）。刻意**不自动落库**：结果只作草稿，由用户确认。

模型会看错，直接写进日历比看错本身更糟——日历是用户唯一的事实来源。
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel

from ..deps import current_identity
from ..errors import ApiError, ErrorCode, envelope
from ..security import IdentityPrincipal
from ..services import vision, vision_text
from ..services.storage import ImageStorage

router = APIRouter(prefix="/api/v1/ai", tags=["ai"])

VISION_TIMEZONE = "Asia/Shanghai"


class ParseTextIn(BaseModel):
    """手机端 OCR 出来的文字；`today` / `timezone` 不给就按服务端算。"""

    text: str | None = None
    today: str | None = None
    timezone: str | None = None


@router.post("/events/recognize")
async def recognize_events(
    file: UploadFile | None = File(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
) -> dict:
    """上传图片，返回识别出的日程草稿（**可能多条**，也可能为空）。"""
    if file is None:
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少上传文件")
    content = await file.read()
    # 复用上传通道：格式按文件头判定、按内容哈希落盘，结果里能带回这张图的 URL
    stored = ImageStorage().store(content)
    items = vision.recognize(
        content,
        stored.content_type,
        datetime.now(ZoneInfo(VISION_TIMEZONE)).date().isoformat(),
        VISION_TIMEZONE,
    )
    return envelope(
        {
            "provider": vision.provider_name(),
            "imageUrl": stored.url,
            "items": [item.to_dict() for item in items],
        }
    )


@router.post("/events/parse-text")
async def parse_text(
    payload: ParseTextIn | None = None,
    principal: IdentityPrincipal = Depends(current_identity),
) -> dict:
    """OCR 文字 → 日程草稿（**图片不出手机**，这里只收文字）。

    返回 `items[]`，每条含 `title`、`at`（**可为空**：通知里没写日期）、`timezone`、`locationName?`、`description?`。
    模型未配置或不可用返回 `90002`（与「图里确实没有要做的事」是两件事：后者返回空 `items`）。
    """
    timezone = (payload.timezone if payload and payload.timezone else VISION_TIMEZONE)
    today = (payload.today if payload and payload.today
             else datetime.now(ZoneInfo(timezone)).date().isoformat())
    # complete_json 走的是同步 urllib：扔进线程，别把事件循环按住
    items = await asyncio.to_thread(
        vision_text.parse, payload.text if payload else None, today, timezone)
    return envelope({"items": [item.to_dict() for item in items]})
