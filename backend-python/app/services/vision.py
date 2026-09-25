"""拍照 / 相册 → 日程草稿（spec §4.1.9）。行为与 Java 版 LocalVisionEventRecognizer 对齐。

把图片发给**本机 / 内网**的 OpenAI 兼容推理服务（Ollama / vLLM / LM Studio 都能起这个接口）：
日程照片属于隐私数据，不该为了 OCR 出网；换模型只改配置。

「一定拿到我们要的 JSON」分四层保障（只靠提示词是不够的）：

1. **约束解码**：请求里带 `response_format`（JSON 模式，或带 schema 的严格模式）；
2. **提示词**写清结构，并要求「一图多活动」「看不清时间不要猜」；
3. **容错解析**：代码块、前后夹带的解释、单引号、尾逗号、只回一个对象，都按通行做法先剥再解析；
4. **修复重试**：还解析不出来就把上一次的坏输出回灌给模型让它只输出 JSON；
   再失败就明确报 90002——绝不让格式不对的结果流到 App。
"""

from __future__ import annotations

import base64
import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

from ..config import settings
from ..errors import ApiError, ErrorCode

logger = logging.getLogger(__name__)

UNCONFIGURED_MESSAGE = "识别服务未配置（spec §4.1.9）：请在后端配置本地多模态模型"


@dataclass(frozen=True)
class RecognizedEvent:
    """识别出的一条日程草稿；时间字段为 None 表示**没看出时间**（App 会降级成待办）。

    kind：模型判断这是 EVENT（日程）还是 TASK（待办）——通知里「假期 9/25–9/27」是日程，
    「登记截止 9/24」是待办，而截止日期同样是个时间，靠「有没有时间」猜会把待办误判成日程。
    """

    title: str
    kind: str
    start_at: datetime | None
    end_at: datetime | None
    due_at: datetime | None
    all_day: bool
    location_name: str | None
    description: str | None
    confidence: float | None

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "kind": self.kind,
            "startAt": self.start_at,
            "endAt": self.end_at,
            "dueAt": self.due_at,
            "allDay": self.all_day,
            "locationName": self.location_name,
            "description": self.description,
            "confidence": self.confidence,
        }


class _NotJson(Exception):
    """模型没给出可解析的 JSON；带上原文供修复重试使用。"""

    def __init__(self, raw_reply: str, message: str):
        super().__init__(message)
        self.raw_reply = raw_reply


def configured() -> bool:
    return bool(settings.vision_base_url.strip() and settings.vision_model.strip())


def provider_name() -> str:
    return "local-vision" if configured() else "unconfigured"


def recognize(image: bytes, content_type: str, today: str, timezone: str) -> list[RecognizedEvent]:
    if not configured():
        # 明确报「未配置」，不要返回空列表冒充「图里没有日程」——后者会让用户反复重拍
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, UNCONFIGURED_MESSAGE)

    previous_reply: str | None = None
    attempts = max(1, settings.vision_max_attempts)
    for attempt in range(1, attempts + 1):
        try:
            return _parse_items(_call(image, content_type, today, timezone, previous_reply), timezone)
        except ApiError:
            raise
        except Exception as exc:  # noqa: BLE001 - 解析失败要重试，最终给用户明确结论
            previous_reply = exc.raw_reply if isinstance(exc, _NotJson) else None
            logger.warning("识别结果第 %s 次解析失败（%s）", attempt, exc)
            if attempt == attempts:
                raise ApiError(
                    ErrorCode.THIRD_PARTY_UNAVAILABLE, f"识别结果不是合法 JSON，已重试 {attempts} 次"
                ) from exc
    raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "识别失败")


def _call(
    image: bytes, content_type: str, today: str, timezone: str, previous_reply: str | None
) -> str:
    body = json.dumps(
        {
            "model": settings.vision_model,
            "stream": False,
            **_structured_output(),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _prompt(today, timezone, previous_reply)},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{content_type};base64,"
                                + base64.b64encode(image).decode()
                            },
                        },
                    ],
                }
            ],
        }
    ).encode()
    url = settings.vision_base_url.rstrip("/") + "/chat/completions"
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {settings.vision_api_key}")
    try:
        with urllib.request.urlopen(request, timeout=settings.vision_timeout) as response:  # noqa: S310
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, f"识别服务返回 HTTP {exc.code}") from exc
    except Exception as exc:  # noqa: BLE001 - 本地服务没起来是常见情况，要给明确提示
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, f"识别服务不可用：{exc}") from exc

    choices = payload.get("choices") or []
    if not choices:
        raise _NotJson("", "识别服务没有返回 choices")
    return (choices[0].get("message") or {}).get("content") or ""


def _structured_output() -> dict:
    """结构化输出约束：json_schema 最强，json_object 兼容面最广。"""
    mode = (settings.vision_structured_output or "json_object").strip().lower()
    if mode == "none":
        return {}
    if mode == "json_schema":
        return {
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "recognized_events",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "events": {"type": "array", "items": {"type": "object"}}
                        },
                        "required": ["events"],
                    },
                },
            }
        }
    return {"response_format": {"type": "json_object"}}


def _prompt(today: str, timezone: str, previous_reply: str | None) -> str:
    base = (
        f"你是日程识别助手。今天是 {today}，时区是 {timezone}。\n"
        "从图片里找出**所有**日程与待办事项，只输出 JSON，不要解释、不要 markdown 代码块：\n"
        '{"events":[{"title":"...","kind":"EVENT","startAt":"YYYY-MM-DDTHH:mm:ss+08:00",'
        '"endAt":"...","dueAt":"","allDay":false,"location":"...","description":"...",'
        '"confidence":0.9}]}\n'
        "规则：\n"
        "1. 一张图里可能有多场活动，**全部列出**，不要合并成一条；\n"
        "2. kind 只能是 EVENT（占一段时间的日程）或 TASK（一件要去做的事）：\n"
        "   通知里的「假期 9/25–9/27」是 EVENT，「登记截止 9/24」「提交材料」这类是 TASK；\n"
        "3. EVENT 的时间放 startAt / endAt；TASK 的截止时间放 dueAt"
        "（「登记截止 9/24」→ 2026-09-24T23:59:00+08:00）；时间看不清就留空字符串，**不要猜**；\n"
        "4. 「明天下午三点」这类相对时间，按上面的今天与时区换算成绝对时间；\n"
        "5. **全天 / 跨天区间**把 allDay 置 true：startAt 给第一天 00:00，"
        "endAt 给**最后一天的次日 00:00**（iCalendar 约定：9/25–9/27 写成 09-25 → 09-28 00:00）；\n"
        "6. 通知正文里的地址、网址、要求放进 description，标题只写这件事本身；\n"
        "7. 认不出的字段留空字符串，**不要编造**。\n"
    )
    if previous_reply is None:
        return base
    # 修复重试：把坏输出原样回灌，明确要求只回 JSON——比重新描述任务有效得多
    return (
        base
        + "\n上一次的输出不是合法 JSON，无法解析。原始输出如下（可能含解释文字或格式错误）：\n"
        + f"<bad_output>\n{previous_reply}\n</bad_output>\n"
        + "请**只**重新输出修正后的 JSON（同一个结构，不要任何解释、不要代码块标记）。\n"
    )


_TRAILING_COMMA = re.compile(r",(\s*[}\]])")


def extract_json(raw_reply: str) -> str:
    """从回复里抠出 JSON：去代码围栏 → 从第一个花括号/方括号切到最后一个闭合符。"""
    text = (raw_reply or "").strip()
    if text.startswith("```"):
        first_break = text.find("\n")
        last_fence = text.rfind("```")
        if first_break > 0 and last_fence > first_break:
            text = text[first_break + 1 : last_fence].strip()
    starts = [index for index in (text.find("{"), text.find("[")) if index >= 0]
    if not starts:
        raise _NotJson(raw_reply, "回复里找不到 JSON")
    start = min(starts)
    closing = "}" if text[start] == "{" else "]"
    end = text.rfind(closing)
    if end < start:
        raise _NotJson(raw_reply, "JSON 不完整")
    return text[start : end + 1]


def _loads(raw_reply: str) -> object:
    """先按原样解析，再逐层容忍常见畸形。

    <p>模型常见的「不太老实」有三类：尾逗号、单引号、以及 JSON 里的
    `true/false/null`——第三类用 `literal_eval` 兜（它只解析字面量，不会执行代码）。
    真正离谱的（根本不是 JSON）交给「修复重试 + 明确报错」，不做无原则的兜底。
    """
    text = extract_json(raw_reply)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        without_commas = _TRAILING_COMMA.sub(r"\1", text)
        try:
            return json.loads(without_commas)
        except json.JSONDecodeError:
            return _literal_eval(without_commas)


def _literal_eval(text: str) -> object:
    """单引号 + 尾逗号的组合：转成 Python 字面量再解析。"""
    import ast

    python_literal = (
        text.replace("true", "True").replace("false", "False").replace("null", "None")
    )
    try:
        return ast.literal_eval(python_literal)
    except (ValueError, SyntaxError) as exc:
        raise _NotJson(text, f"回复不是合法 JSON：{exc}") from exc


def _parse_items(raw_reply: str, timezone: str) -> list[RecognizedEvent]:
    payload = _loads(raw_reply)
    if isinstance(payload, list):
        events = payload
    elif isinstance(payload, dict) and isinstance(payload.get("events"), list):
        events = payload["events"]
    elif isinstance(payload, dict) and "title" in payload:
        # 模型只给了一条、直接返回对象：包一层而不是判失败
        events = [payload]
    else:
        raise _NotJson(raw_reply, "回复里没有 events 数组")

    zone = ZoneInfo(timezone)
    items: list[RecognizedEvent] = []
    for node in events:
        if not isinstance(node, dict):
            continue
        title = str(node.get("title") or "").strip()
        if not title:
            continue
        items.append(
            RecognizedEvent(
                title=title,
                kind=_parse_kind(node.get("kind"), node.get("startAt")),
                start_at=_parse_time(node.get("startAt"), zone),
                end_at=_parse_time(node.get("endAt"), zone),
                due_at=_parse_time(node.get("dueAt"), zone),
                all_day=_parse_bool(node.get("allDay")),
                location_name=_blank_to_none(node.get("location")),
                description=_blank_to_none(node.get("description")),
                confidence=_parse_float(node.get("confidence")),
            )
        )
    return items


def _parse_kind(value, start_at) -> str:
    """模型给了 kind 就用它；没给才按有没有开始时间兜底。"""
    text = str(value or "").strip().upper()
    if "TASK" in text or "待办" in text:
        return "TASK"
    if "EVENT" in text or "日程" in text:
        return "EVENT"
    return "EVENT" if str(start_at or "").strip() else "TASK"


def _parse_time(value, zone: ZoneInfo) -> datetime | None:
    if value is None or isinstance(value, (int, float)):
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=zone)
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
        # 「2026-09-26 15:00」这种没有偏移量的写法会被解析成 naive：按请求时区补上，
        # 否则 App 拿到的是「无时区时间」，不同设备会显示成不同时刻
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y年%m月%d日 %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=zone)
        except ValueError:
            continue
    try:  # 只给了日期 → 当天 00:00（allDay 场景）
        return datetime.combine(date.fromisoformat(text[:10]), datetime.min.time(), zone)
    except ValueError:
        # 实在解析不了就当「没看出时间」，让用户补，而不是丢掉整条
        return None


def _parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    return text in {"true", "1", "是", "yes"}


def _parse_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _blank_to_none(value) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None
