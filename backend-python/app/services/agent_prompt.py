"""系统提示词的加载与渲染（spec §11 阶段三）。

提示词正文是 `app/resources/agent/prompt.md`，与 Java 版 `chronoflow-agent` 里那一份**逐字节相同**
（`tests/test_modules.py::test_agent_prompt_matches_java` 钉住了这一点）。
两版各存一份而不是互相 import：两边要能独立部署；一致靠测试守，不靠目录结构守。

`VERSION` 随每轮 token 用量一起进日志：线上效果有变化时，第一件事应该是确认
"跑的是哪一版提示词"。**改提示词正文必须同时改这里**。
"""

from __future__ import annotations

import re
from pathlib import Path

# 与 Java 版 AgentPrompt.VERSION 保持一致（只改日期与序号即可）
VERSION = "2026-09-28.5"

PROMPT_PATH = Path(__file__).resolve().parent.parent / "resources" / "agent" / "prompt.md"

_PLACEHOLDER = re.compile(r"\{\{[a-z_]+\}\}")


def template() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def render(values: dict[str, str]) -> str:
    """把 {{占位符}} 换成实际内容；没提供的替换成空串（绝不把 `{{...}}` 原样送给模型）。"""
    rendered = template()
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", value or "")
    return _PLACEHOLDER.sub("", rendered)


def version() -> str:
    return VERSION
