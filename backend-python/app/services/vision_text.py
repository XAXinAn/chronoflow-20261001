"""OCR 文字 → 日程草稿（spec §4.1.9）。行为与 Java 版 `AgentTextParseService` 对齐。

图片识别日程分两段：手机端的端侧 OCR（PaddleOCR PP-OCRv4）**又准又不花钱、图片还不出手机**，
「一段通知里有几件要做的事、哪句是时间」这种理解活交给服务端模型（百炼）。

提示词正文在 `app/resources/agent/vision-prompt.md`，与 Java 版 `chronoflow-agent` 里那一份
**逐字节相同**（`tests/test_vision.py` 钉住了这一点）。抽取口径全部写在提示词里：
只抽「要你去做的事」、日期有就写没有就留空、不猜时刻。这里只负责调用与容错解析。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..errors import ApiError, ErrorCode
from . import agent_model

PROMPT_PATH = Path(__file__).resolve().parent.parent / "resources" / "agent" / "vision-prompt.md"
# OCR 文字上限：一张通知再长也就几千字，超了多半是把整本书拍进来了
MAX_TEXT_LENGTH = 4000


@dataclass(frozen=True)
class ParsedEventDraft:
    """抽取出来的一条日程草稿；`at` 为 None 表示**文字里没写日期**（合法结果，由用户补）。

    比整图识别那一路的 `RecognizedEvent` 更窄：**只产出日程**，没有 kind、没有 confidence。
    """

    title: str
    at: str | None
    timezone: str
    location_name: str | None
    description: str | None

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "at": self.at,
            "timezone": self.timezone,
            "locationName": self.location_name,
            "description": self.description,
        }


def configured() -> bool:
    return agent_model.client().available()


def template() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def parse(text: str | None, today: str, timezone: str) -> list[ParsedEventDraft]:
    """调模型把 OCR 文字抽成草稿。未配置模型 / 缺少文字时如实报错，不空跑。"""
    if not configured():
        raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "解析模型未配置")
    if not text or not text.strip():
        raise ApiError(ErrorCode.PARAM_MISSING, "缺少要解析的文字")

    zone = ZoneInfo(timezone or "Asia/Shanghai")
    prompt = (
        template()
        .replace("{{today}}", today or "")
        .replace("{{timezone}}", zone.key)
        .replace("{{text}}", text[:MAX_TEXT_LENGTH])
    )
    reply = agent_model.client().complete_json(prompt)
    return parse_items(reply, zone.key)


def parse_items(reply: str | None, timezone: str) -> list[ParsedEventDraft]:
    """容错解析：模型可能包 ```json、前后带解释；解析不出来就当「没识别到」，而不是报错。

    **`at` 缺失是合法结果**（通知里没写日期），照常返回这一条。
    """
    json_text = _extract_json_object(reply)
    if json_text is None:
        return []
    try:
        payload = json.loads(json_text)
    except json.JSONDecodeError:
        return []
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []

    zone = ZoneInfo(timezone or "Asia/Shanghai")
    drafts: list[ParsedEventDraft] = []
    for node in items:
        if not isinstance(node, dict):
            continue
        title = str(node.get("title") or "").strip()
        if not title:
            # 没标题的条目没法确认也没法建，丢掉——宁可少一条，也别给用户一条空白卡
            continue
        drafts.append(
            ParsedEventDraft(
                title=title,
                at=_format_at(node.get("at"), zone),
                # 时区以服务端为准：at 已按请求时区解析，回带别的时区只会让两者对不上
                timezone=zone.key,
                location_name=_blank_to_none(node.get("locationName")),
                description=_blank_to_none(node.get("description")),
            )
        )
    return drafts


def _format_at(value, zone: ZoneInfo) -> str | None:
    """把模型给的时间格式化成带偏移量的 ISO 字符串；解析不了就当「没写日期」，不猜。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=zone).isoformat()
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)).isoformat()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y年%m月%d日 %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=zone).isoformat()
        except ValueError:
            continue
    try:  # 只给了日期 → 当天 00:00（只说了哪一天）
        return datetime.combine(date.fromisoformat(text[:10]), datetime.min.time(), zone).isoformat()
    except ValueError:
        return None


def _blank_to_none(value) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _extract_json_object(raw: str | None) -> str | None:
    """抽第一个配平的 `{...}`：模型爱在前后加解释或 ```json 围栏。"""
    if not raw:
        return None
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(raw)):
        char = raw[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return raw[start : index + 1]
    return None
