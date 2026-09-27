"""合规文本（docs/legal/*.md）的读取与 Markdown → HTML 渲染。

与 Java 版 `com.xatodo.support.legal.LegalController` 行为一致：同一份 Markdown、
同样的白名单、同样「输出里不可能出现 <script>」的约束。

为什么两版都要出这个页面：契约里有 `GET /api/v1/legal/{doc}`，
两版后端必须都能独立满足它（`OpenApiContractTest` / `test_contract.py` 是门禁）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# services/legal.py → app → backend-python → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[3]

#: slug → 页面标题。白名单而非拼路径：路径穿越必须在一开始就不可能。
LEGAL_DOCUMENTS: dict[str, str] = {
    "privacy-policy": "时纪流隐私政策",
    "user-agreement": "时纪流用户服务协议",
    "children-privacy": "时纪流儿童个人信息保护声明",
    "personal-info-collected": "时纪流已收集个人信息清单",
    "shared-info-with-third-parties": "时纪流与第三方共享个人信息清单",
}

_ORDERED_ITEM = re.compile(r"^\s*\d+\.\s+(.*)$")
_UNORDERED_ITEM = re.compile(r"^\s*[-*]\s+(.*)$")
_BARE_URL = re.compile(r"https?://[^\s<>()]+")
_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_INLINE_CODE = re.compile(r"`([^`]+)`")
_TABLE_DIVIDER = re.compile(r"^\s*\|?[\s:|-]+\|?\s*$")


def legal_dir() -> Path:
    """合规文本目录；部署时可用 XATODO_LEGAL_DIR 指到镜像里拷贝的位置。"""
    return Path(os.getenv("XATODO_LEGAL_DIR", _REPO_ROOT / "docs" / "legal"))


def load_document(doc: str) -> tuple[str, str] | None:
    """返回 (标题, HTML)；slug 不在白名单或文件不存在时返回 None（交给路由回 404）。"""
    title = LEGAL_DOCUMENTS.get(doc)
    if title is None:
        return None
    path = legal_dir() / f"{doc}.md"
    if not path.is_file():
        return None
    return title, render_page(title, markdown_to_html(path.read_text(encoding="utf-8")))


def split_row(row: str) -> list[str]:
    body = row.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [cell.strip() for cell in body.split("|")]


def _linkify(text: str) -> str:
    return _BARE_URL.sub(lambda m: f'<a href="{m.group(0)}">{m.group(0)}</a>', text)


def _auto_link(html: str) -> str:
    """裸 URL 自动成链，但跳过已经在标签里的部分（否则会把 href 也套一层）。"""
    out: list[str] = []
    cursor = 0
    while cursor < len(html):
        opening = html.find("<", cursor)
        closing = -1 if opening < 0 else html.find(">", opening)
        if opening < 0 or closing < 0:
            out.append(_linkify(html[cursor:]))
            break
        out.append(_linkify(html[cursor:opening]))
        out.append(html[opening : closing + 1])
        cursor = closing + 1
    return "".join(out)


def inline(text: str) -> str:
    """行内语法：先转义 HTML，再按占位符—替换—还原的顺序处理。"""
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    codes: list[str] = []

    def stash(match: re.Match[str]) -> str:
        codes.append(match.group(1))
        return f"\u0000{len(codes) - 1}\u0000"

    escaped = _INLINE_CODE.sub(stash, escaped)
    escaped = _BOLD.sub(r"<strong>\1</strong>", escaped)
    escaped = _MARKDOWN_LINK.sub(r'<a href="\2">\1</a>', escaped)
    escaped = _auto_link(escaped)
    for index, code in enumerate(codes):
        escaped = escaped.replace(f"\u0000{index}\u0000", f"<code>{code}</code>")
    return escaped


def _render_list(lines: list[str], start: int, out: list[str], tag: str, pattern: re.Pattern[str]) -> int:
    out.append(f"<{tag}>")
    index = start
    while index < len(lines):
        match = pattern.match(lines[index])
        if not match:
            break
        item = match.group(1).strip()
        index += 1
        while index < len(lines):
            nxt = lines[index]
            if not nxt.strip() or pattern.match(nxt) or not nxt[0].isspace():
                break
            item += " " + nxt.strip()
            index += 1
        out.append(f"<li>{inline(item)}</li>")
    out.append(f"</{tag}>")
    return index


def markdown_to_html(markdown: str) -> str:
    lines = markdown.split("\n")
    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped in {"---", "***"}:
            out.append("<hr/>")
            index += 1
            continue
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            out.append(f"<h{level}>{inline(stripped[level:].strip())}</h{level}>")
            index += 1
            continue
        if stripped.startswith(">"):
            quoted: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quoted.append(re.sub(r"^>\s?", "", lines[index].strip()))
                index += 1
            # 逐行转义后再拼 <br/>：整体丢给 inline() 会把换行标签自己也转义掉
            out.append("<blockquote>" + "<br/>".join(inline(line) for line in quoted) + "</blockquote>")
            continue
        if index + 1 < len(lines) and lines[index].strip().startswith("|") and _TABLE_DIVIDER.match(
            lines[index + 1]
        ):
            header = split_row(lines[index])
            out.append("<table><thead><tr>")
            out.extend(f"<th>{inline(cell)}</th>" for cell in header)
            out.append("</tr></thead><tbody>")
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                out.append("<tr>")
                out.extend(f"<td>{inline(cell)}</td>" for cell in split_row(lines[index]))
                out.append("</tr>")
                index += 1
            out.append("</tbody></table>")
            continue
        if _ORDERED_ITEM.match(line):
            index = _render_list(lines, index, out, "ol", _ORDERED_ITEM)
            continue
        if _UNORDERED_ITEM.match(line):
            index = _render_list(lines, index, out, "ul", _UNORDERED_ITEM)
            continue

        paragraph: list[str] = []
        while index < len(lines):
            current = lines[index]
            current_stripped = current.strip()
            if (
                not current_stripped
                or current_stripped.startswith(("#", ">", "|"))
                or current_stripped in {"---", "***"}
                or _ORDERED_ITEM.match(current)
                or _UNORDERED_ITEM.match(current)
            ):
                break
            paragraph.append(current_stripped)
            index += 1
        out.append("<p>" + inline(" ".join(paragraph)) + "</p>")
    return "\n".join(out)


_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
  html{{-webkit-text-size-adjust:100%}}
  body{{margin:0;padding:24px 18px 64px;background:#fff;color:#1a1a1a;
       font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}}
  main{{max-width:760px;margin:0 auto}}
  h1{{font-size:24px;line-height:1.4;margin:0 0 8px}}
  h2{{font-size:19px;margin:32px 0 12px;padding-top:8px;border-top:1px solid #ececec}}
  h3{{font-size:17px;margin:24px 0 8px}}
  h4,h5,h6{{font-size:16px;margin:20px 0 8px}}
  p,li{{margin:8px 0}}
  ul,ol{{padding-left:22px}}
  blockquote{{margin:16px 0;padding:12px 16px;background:#f6f6f6;border-left:3px solid #999}}
  table{{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}}
  th,td{{border:1px solid #e2e2e2;padding:8px 10px;text-align:left;vertical-align:top;word-break:break-word}}
  th{{background:#fafafa}}
  code{{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:14px}}
  a{{color:#0a58ca;word-break:break-all}}
  hr{{border:0;border-top:1px solid #ececec;margin:28px 0}}
  strong{{font-weight:600}}
</style>
</head>
<body><main>
{body}
</main></body>
</html>"""


def render_page(title: str, body: str) -> str:
    return _PAGE.format(title=title, body=body)
