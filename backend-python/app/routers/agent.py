"""小安的对话流、授权答复与语音转写（spec §11 阶段三）。

协议与 Java 版逐字对齐：`POST /ai/agent/chat` 是 `text/event-stream`，
事件 `status` / `delta` / `tool` / `action` / `done` / `error`；
`action` 发出后**这条流保持打开**，等 `POST /ai/agent/approvals` 把答复送进来。
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..db import SessionLocal
from ..deps import current_identity
from ..errors import ApiError, ErrorCode, envelope
from ..security import IdentityPrincipal
from ..services import agent_approvals, agent_chat, agent_model, agent_scope, agent_transcribe

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/ai", tags=["agent"])


class ToolCallIn(BaseModel):
    """客户端送回的一次工具调用（模型上一轮发起的）。"""

    id: str | None = None
    name: str | None = None
    arguments: str | None = None


class ChatTurnIn(BaseModel):
    role: str
    content: str | None = None
    toolCalls: list[ToolCallIn] | None = None
    toolCallId: str | None = None


class AgentChatIn(BaseModel):
    # 带工具往返的完整历史：assistant.toolCalls 后面必须跟 role=tool + toolCallId
    messages: list[ChatTurnIn] | None = None
    # 当前组织身份（可空）：服务端会校验归属，越权一律 20003
    orgIdentityId: int | None = None


class ApprovalIn(BaseModel):
    actionId: str | None = None
    allow: bool | None = None
    feedback: str | None = None


@router.post("/agent/chat")
async def chat(payload: AgentChatIn | None = None,
               principal: IdentityPrincipal = Depends(current_identity)):
    """小安的对话流。**模型未配置时不开流**，直接返回统一信封 90002。"""
    # 请求体整体可选：这样"没带 body"不会被框架先判成 422，
    # 而是按我们的口径给出 10001（也与 Java 版的 @RequestBody(required=false) 对齐）
    incoming = payload or AgentChatIn()
    if not agent_model.client().available():
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "小安还没有接入模型")
    turns = [turn.model_dump() for turn in (incoming.messages or [])]
    if not turns:
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少 messages")

    # 隔离沙盒：越权校验放在建流之前，身份不对就不该开始花钱。
    # 用一次性的会话解析，别把连接在这条长流上挂几分钟。
    with SessionLocal() as session:
        scope = agent_scope.resolve(session, principal.account_id, incoming.orgIdentityId)

    async def frames():
        async for name, data in agent_chat.events(scope, turns):
            yield f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    # 两个响应头是流式的「开关」：不许缓存、不许反代缓冲（nginx 侧另有 proxy_buffering off）
    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/agent/approvals")
async def approve(payload: ApprovalIn | None = None,
                  principal: IdentityPrincipal = Depends(current_identity)):
    """用户对一次授权请求的答复（mewcode 的 `PermissionReply`）。

    允许就真正落库、拒绝就写一条「什么都没改」的工具结果，两条路都会让**同一条流**继续跑。
    所以这个端点必须能被同一个账号在流还没结束时调用。
    """
    if payload is None or not payload.actionId:
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少 actionId")
    if not agent_approvals.resolve(principal.account_id, payload.actionId,
                                   bool(payload.allow), payload.feedback):
        # 多半是已经超时或整条流早就结束了：不当成错误，客户端不必重试
        logger.info("授权答复没有对应的等待项（已超时？）：%s", payload.actionId)
    return envelope(None)


@router.post("/transcribe")
async def transcribe(
    file: UploadFile | None = File(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
) -> dict:
    """长按说话 → 文字。音频只在内存里转 base64 转发，不落盘。"""
    if file is None:
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少上传文件")
    # 多读一个字节就能判断「超限」，不必把整个大文件读进内存
    data = await file.read(settings.agent_asr_max_bytes + 1)
    return envelope(agent_transcribe.transcribe(data, file.content_type))
