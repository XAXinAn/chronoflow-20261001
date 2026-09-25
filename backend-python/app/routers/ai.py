"""拍照 / 相册 → 日程草稿（spec §4.1.9）。刻意**不自动落库**：结果只作草稿，由用户确认。

模型会看错，直接写进日历比看错本身更糟——日历是用户唯一的事实来源。
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, UploadFile

from ..deps import current_identity
from ..errors import ApiError, ErrorCode, envelope
from ..security import IdentityPrincipal
from ..services import vision
from ..services.storage import ImageStorage

router = APIRouter(prefix="/api/v1/ai", tags=["ai"])

VISION_TIMEZONE = "Asia/Shanghai"


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
