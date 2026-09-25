from __future__ import annotations

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_session
from ..deps import current_identity
from ..errors import ApiError, ErrorCode, envelope
from ..security import IdentityPrincipal
from ..services.feedback import FeedbackService
from ..services.storage import ImageStorage

router = APIRouter(prefix="/api/v1", tags=["support"])


class FeedbackCreate(BaseModel):
    category: str = "OTHER"
    content: str = Field(min_length=1)
    # 只接受上传通道返回的相对 URL（见 FeedbackService._validate_images）
    images: list[str] | None = None


@router.post("/uploads/images")
async def upload_image(
    file: UploadFile | None = File(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
) -> dict:
    """上传单张图片（spec §5.10）。头像与反馈图片共用。"""
    if file is None:
        # 用可空参数手动判空：交给框架的话，缺字段是一个没有 message 的 422
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少上传文件")
    content = await file.read()
    stored = ImageStorage().store(content)
    return envelope({"url": stored.url, "size": stored.size, "contentType": stored.content_type})


@router.post("/feedback")
def submit_feedback(
    payload: FeedbackCreate,
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    service = FeedbackService(session)
    return envelope(
        service.create(principal.account_id, principal.identity_id, payload.model_dump())
    )


@router.get("/feedback")
def my_feedback(
    limit: int | None = Query(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
    session: Session = Depends(get_session),
) -> dict:
    return envelope(FeedbackService(session).list_mine(principal.account_id, limit))
