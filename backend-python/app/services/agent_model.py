"""助手模型接入点（spec §11 阶段三）。

与 Java 版 `chronoflow-agent` 的 `AgentModelClient` 是同一条缝：**照 OpenAI 兼容形状说话**，
所以换模型只换实现（百炼 / 本地 vLLM / 以后的其它云），而测试可以注入假上游——
这里要验证的是我们这一侧的行为（工具循环、授权回路、事件序列、越权拦截），
不是模型本身聪不聪明。

用标准库 `urllib` 而不是引 httpx：与本仓其它出站调用（geo / vision / holiday_sync）一致，
也让运行时不依赖一个只在 dev 里出现的包。阻塞的那一段由调用方扔进 `asyncio.to_thread`。
"""

from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from ..config import settings
from ..errors import ApiError, ErrorCode

logger = logging.getLogger(__name__)


class AgentStreamAborted(Exception):
    """客户端已经走了 / 用户点了停止：立刻停下手上的活，把异常穿出去。"""


@dataclass
class CompletionResult:
    """一次补全的结果（与 Java 版 CompletionResult 同形状）。"""

    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    finish_reason: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass
class TranscriptionResult:
    text: str
    language: str | None = None


class AgentModelClient:
    """模型接入点的接口。实现方只需覆盖这几个方法。"""

    def provider_name(self) -> str:
        raise NotImplementedError

    def available(self) -> bool:
        """是否已配置可用；未配置时调用方必须走 90002 分支，而不是发起一次注定失败的请求。"""
        raise NotImplementedError

    def transcription_available(self) -> bool:
        raise NotImplementedError

    def complete(self, messages: list[dict], tools: list[dict], on_delta) -> CompletionResult:
        raise NotImplementedError

    def complete_json(self, prompt: str) -> str:
        """一次性的结构化补全（JSON 模式 + 温度 0），给「OCR 文字 → 日程草稿」这类抽取用。

        与 `complete` 分开：抽取不需要流式、不需要工具，要的是**稳定**的 JSON，
        所以单独一条缝；注入假上游时也只需覆盖这一个方法。
        """
        raise NotImplementedError

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptionResult:
        raise NotImplementedError


class _Accumulator:
    """把上游的流式增量帧拼成一次完整的回复。

    工具调用的参数是**分片**下发的（`{"index":0,"function":{"arguments":"{\\"ke"}}` 这样一段段来），
    拼错一个字段就是「工具名对、参数空」，界面表现为模型什么都查不到。
    """

    def __init__(self) -> None:
        self._text: list[str] = []
        self._calls: dict[int, dict] = {}
        self.finish_reason: str | None = None
        self.prompt_tokens = 0
        self.completion_tokens = 0

    def accept(self, chunk: dict) -> str:
        usage = chunk.get("usage")
        if isinstance(usage, dict):
            self.prompt_tokens = int(usage.get("prompt_tokens") or 0)
            self.completion_tokens = int(usage.get("completion_tokens") or 0)

        choices = chunk.get("choices") or []
        if not choices:
            # 只带 usage 的收尾帧：正文与工具调用都没有
            return ""
        choice = choices[0] or {}
        if choice.get("finish_reason"):
            self.finish_reason = choice["finish_reason"]

        delta = choice.get("delta") or {}
        piece = delta.get("content") or ""
        if piece:
            self._text.append(piece)

        for call in delta.get("tool_calls") or []:
            partial = self._calls.setdefault(int(call.get("index") or 0),
                                             {"id": None, "name": None, "arguments": ""})
            # id / name **只在非空时覆盖**：百炼后续每一帧都会带 `"id": ""`，
            # 无脑覆盖会把第一帧拿到的真实 id 冲掉，回灌工具结果时 tool_call_id 就对不上了
            if call.get("id"):
                partial["id"] = call["id"]
            function = call.get("function") or {}
            if function.get("name"):
                partial["name"] = function["name"]
            if isinstance(function.get("arguments"), str):
                partial["arguments"] += function["arguments"]
        return piece

    def result(self) -> CompletionResult:
        calls = []
        for partial in self._calls.values():
            if not partial["name"]:
                continue
            calls.append({
                "id": partial["id"] or f"call_{len(calls)}",
                "name": partial["name"],
                "arguments": partial["arguments"],
            })
        return CompletionResult(
            text="".join(self._text),
            tool_calls=calls,
            finish_reason=self.finish_reason,
            prompt_tokens=self.prompt_tokens,
            completion_tokens=self.completion_tokens,
        )


class DashScopeAgentModelClient(AgentModelClient):
    """阿里云百炼（通义千问）实现。

    用的是百炼的 **OpenAI 兼容**模式：`POST {base}/chat/completions`，`stream: true`。
    几个已实测确认的参数（与 Java 版写死的一致）：
    `enable_thinking=false` 关思考流；`stream_options.include_usage=true` 最后一帧才带用量；
    `tool_choice` **不设 `required`**（思考模式下会被上游拒绝）。
    """

    def provider_name(self) -> str:
        return f"dashscope:{settings.agent_model}" if self.available() else "unconfigured"

    def available(self) -> bool:
        return bool(settings.agent_base_url.strip()
                    and settings.agent_api_key.strip()
                    and settings.agent_model.strip())

    def transcription_available(self) -> bool:
        return self.available() and bool(settings.agent_asr_url.strip()
                                         and settings.agent_asr_model.strip())

    def _asr_api_key(self) -> str:
        # 没单独配就用主 Key（同一个百炼账号）
        return settings.agent_asr_api_key.strip() or settings.agent_api_key

    def complete(self, messages: list[dict], tools: list[dict], on_delta) -> CompletionResult:
        if not self.available():
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "助手模型未配置")

        payload = {
            "model": settings.agent_model,
            "stream": True,
            "enable_thinking": settings.agent_enable_thinking,
            "max_tokens": settings.agent_max_tokens,
            # 最后一帧带上 token 用量：成本要能观测，否则「为什么这个月账单涨了」无处可查
            "stream_options": {"include_usage": True},
            "messages": messages,
        }
        if tools:
            payload["tools"] = tools

        if _dump_enabled():
            # 排查「模型为什么这么答」这类问题必备；日志里会含用户日程正文，排查完记得 rm 掉
            logger.info("agent upstream request: %s", json.dumps(payload, ensure_ascii=False))

        request = urllib.request.Request(
            settings.agent_base_url.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.agent_api_key}",
                "Accept": "text/event-stream",
            },
            method="POST",
        )

        accumulator = _Accumulator()
        try:
            with urllib.request.urlopen(request, timeout=settings.agent_timeout) as response:
                for raw in response:
                    data = _payload_of(raw.decode("utf-8", errors="replace"))
                    if data is None or data == "[DONE]":
                        continue
                    try:
                        piece = accumulator.accept(json.loads(data))
                    except Exception as ex:  # noqa: BLE001 —— 单帧坏了不该废掉整条回答
                        logger.warning("解析上游流式帧失败: %s", ex)
                        continue
                    if piece:
                        # 客户端已经走了 → 回调抛 AgentStreamAborted，让它直接穿出去
                        on_delta(piece)
        except AgentStreamAborted:
            raise
        except urllib.error.HTTPError as ex:
            detail = ex.read().decode("utf-8", errors="replace")[:200]
            logger.warning("助手上游返回 HTTP %s: %s", ex.code, detail)
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                           f"助手模型返回 HTTP {ex.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as ex:
            logger.warning("助手上游不可达: %s", ex)
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "助手模型暂时不可用") from None
        return accumulator.result()

    def complete_json(self, prompt: str) -> str:
        """非流式的 JSON 抽取：`response_format={"type":"json_object"}` + `temperature=0`。

        与 Java 版 `AgentTextParseService` 调上游的形状一致：模型时不时会在 JSON 前后
        带一句「好的，识别结果如下」，约束解码能挡掉大部分，剩下的交给容错解析。
        """
        if not self.available():
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "解析模型未配置")

        payload = {
            "model": settings.agent_model,
            "stream": False,
            "enable_thinking": settings.agent_enable_thinking,
            "max_tokens": settings.agent_max_tokens,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": prompt}],
        }
        if _dump_enabled():
            logger.info("vision upstream request: %s", json.dumps(payload, ensure_ascii=False))

        request = urllib.request.Request(
            settings.agent_base_url.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.agent_api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=settings.agent_timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as ex:
            detail = ex.read().decode("utf-8", errors="replace")[:200]
            logger.warning("解析上游返回 HTTP %s: %s", ex.code, detail)
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                           f"解析服务返回 HTTP {ex.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as ex:
            logger.warning("解析上游不可达: %s", ex)
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "解析服务暂时不可用") from None
        except json.JSONDecodeError:
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "解析服务返回了非法响应") from None

        choices = body.get("choices") or []
        if not choices:
            return ""
        return (choices[0].get("message") or {}).get("content") or ""

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptionResult:
        if not self.transcription_available():
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别未配置")

        payload: dict = {
            "model": settings.agent_asr_model,
            "input": {
                "messages": [{
                    "role": "user",
                    "content": [{
                        "audio": f"data:{content_type};base64,"
                                 + base64.b64encode(audio).decode("ascii"),
                    }],
                }],
            },
        }
        if settings.agent_asr_language.strip():
            payload["parameters"] = {"asr_options": {"language": settings.agent_asr_language}}

        request = urllib.request.Request(
            settings.agent_asr_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._asr_api_key()}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=settings.agent_asr_timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as ex:
            detail = ex.read().decode("utf-8", errors="replace")[:200]
            logger.warning("语音识别上游返回 HTTP %s: %s", ex.code, detail)
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                           f"语音识别服务返回 HTTP {ex.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as ex:
            logger.warning("语音识别上游不可达: %s", ex)
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别服务暂时不可用") from None
        except json.JSONDecodeError:
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "语音识别返回了非法响应") from None
        return parse_transcription(body)


def parse_transcription(body: dict) -> TranscriptionResult:
    """兼容两种形状：多模态生成接口的 `output.choices[0].message.content[0].text`，
    以及 OpenAI 兼容接口的 `choices[0].message.content`（字符串）。上游换接口时不必改代码。"""
    try:
        content = body["output"]["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        content = None
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                return TranscriptionResult(text=part["text"], language=None)
    try:
        openai_content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        openai_content = None
    if isinstance(openai_content, str):
        return TranscriptionResult(text=openai_content, language=None)
    return TranscriptionResult(text="", language=None)


def _payload_of(line: str) -> str | None:
    """取一行的 `data:` 载荷；不是数据行（空行、注释、其它字段）返回 None。"""
    trimmed = line.strip()
    if not trimmed or trimmed.startswith(":"):
        return None
    if not trimmed.startswith("data:"):
        return None
    return trimmed[len("data:"):].strip()


def _dump_enabled() -> bool:
    """与 Java 版同一个开关：容器里 `touch /tmp/agent-dump-on` 就把真实请求打进日志。"""
    import os
    return os.path.exists("/tmp/agent-dump-on")


_override: AgentModelClient | None = None


def client() -> AgentModelClient:
    global _override
    if _override is None:
        _override = DashScopeAgentModelClient()
    return _override


def set_client(fake: AgentModelClient | None) -> None:
    """测试注入假上游（与 Java 版 @Primary 的 ScriptedAgentModelClient 等价）。"""
    global _override
    _override = fake
