"""语音输入：录音 → 文字（spec §11 阶段三，对照 Java 版 `AgentTranscribeService`）。

与对话同一条分层：**路由只做 HTTP，规则与错误语义都在这里**。

隐私边界：音频只在这次调用的内存里转 base64 转发给百炼，**不落盘、不进对象存储**——
它只是把话变成字，存下来既没有用途，也平白多一份隐私负担。
转出来的文本由 App 填进输入框，**不自动发送**：语音识别会出错，让用户看一眼再发。
"""

from __future__ import annotations

from ..config import settings
from ..errors import ApiError, ErrorCode
from . import agent_model

# 客户端没声明类型时的兜底：手机端录音就是 m4a（spec §6.2 /ai/transcribe）
DEFAULT_CONTENT_TYPE = "audio/mp4"


def enabled() -> bool:
    """转写是否可用；未配置时调用方必须走 90002 分支，而不是发起一次注定失败的请求。"""
    return agent_model.client().transcription_available()


def transcribe(data: bytes | None, content_type: str | None) -> dict:
    """转写一段录音。

    校验顺序是刻意的：**先看有没有文件，再看有没有接入、有没有超限**。
    反过来的话，「未配置 + 忘了带 file」会报成 90002，排查时会被引到模型配置上去。
    """
    if not data:
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少上传文件")
    if not enabled():
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别未配置")
    if len(data) > settings.agent_asr_max_bytes:
        # 录音上限 60 秒，正常也就几百 KB；超了多半是传错了文件
        raise ApiError(ErrorCode.PARAM_INVALID, "录音文件过大")
    result = agent_model.client().transcribe(data, content_type or DEFAULT_CONTENT_TYPE)
    return {"text": result.text, "language": result.language}
