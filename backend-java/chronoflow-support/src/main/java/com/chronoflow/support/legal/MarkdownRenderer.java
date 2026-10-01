package com.chronoflow.support.legal;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 极小的 Markdown → HTML 渲染器，只服务合规文本（{@code docs/legal/*.md}）。
 *
 * <p>为什么自己写而不是引 CommonMark：合规页面要求「纯静态、无脚本、无跳转、
 * 可被自动化分析」（应用宝规范 §一-2②）。自己渲染可以把「输出里绝不可能出现
 * {@code <script>}」这件事写死在代码里，也少一个依赖。
 *
 * <p>支持的范围刚好覆盖合规文本用到的语法：标题、段落、有序/无序列表、
 * 引用块、表格、分隔线、加粗、行内代码、链接、裸 URL 自动成链。
 * **不支持**内嵌 HTML——输入里的尖括号一律转义。
 */
final class MarkdownRenderer {

    private static final Pattern ORDERED_ITEM = Pattern.compile("^\\s*\\d+\\.\\s+(.*)$");
    private static final Pattern UNORDERED_ITEM = Pattern.compile("^\\s*[-*]\\s+(.*)$");
    private static final Pattern BARE_URL = Pattern.compile("https?://[^\\s<>()]+");
    private static final Pattern MARKDOWN_LINK = Pattern.compile("\\[([^\\]]+)\\]\\(([^)\\s]+)\\)");
    private static final Pattern BOLD = Pattern.compile("\\*\\*([^*]+)\\*\\*");
    private static final Pattern INLINE_CODE = Pattern.compile("`([^`]+)`");
    private static final Pattern TABLE_DIVIDER = Pattern.compile("^\\s*\\|?[\\s:|-]+\\|?\\s*$");

    private MarkdownRenderer() {
    }

    static String toHtml(String markdown) {
        List<String> lines = List.of(markdown.split("\n", -1));
        StringBuilder out = new StringBuilder();
        int index = 0;

        while (index < lines.size()) {
            String line = lines.get(index);
            String trimmed = line.strip();

            if (trimmed.isEmpty()) {
                index++;
                continue;
            }
            if (trimmed.equals("---") || trimmed.equals("***")) {
                out.append("<hr/>\n");
                index++;
                continue;
            }
            if (trimmed.startsWith("#")) {
                int level = 0;
                while (level < trimmed.length() && trimmed.charAt(level) == '#') {
                    level++;
                }
                out.append("<h").append(level).append('>')
                        .append(inline(trimmed.substring(level).strip()))
                        .append("</h").append(level).append(">\n");
                index++;
                continue;
            }
            if (trimmed.startsWith(">")) {
                List<String> quoted = new ArrayList<>();
                while (index < lines.size() && lines.get(index).strip().startsWith(">")) {
                    quoted.add(lines.get(index).strip().replaceFirst("^>\\s?", ""));
                    index++;
                }
                // 引用块里的空行要保留成换行，否则「阅读提示」会挤成一坨。
                // 逐行转义后再拼 <br/>：整体丢给 inline() 会把换行标签自己也转义掉。
                out.append("<blockquote>")
                        .append(quoted.stream().map(MarkdownRenderer::inline)
                                .collect(java.util.stream.Collectors.joining("<br/>")))
                        .append("</blockquote>\n");
                continue;
            }
            if (index + 1 < lines.size() && lines.get(index).strip().startsWith("|")
                    && TABLE_DIVIDER.matcher(lines.get(index + 1)).matches()) {
                index = renderTable(lines, index, out);
                continue;
            }
            if (ORDERED_ITEM.matcher(line).matches()) {
                index = renderList(lines, index, out, "ol", ORDERED_ITEM);
                continue;
            }
            if (UNORDERED_ITEM.matcher(line).matches()) {
                index = renderList(lines, index, out, "ul", UNORDERED_ITEM);
                continue;
            }

            // 段落：连续的非空、非块级起始行合并成一段
            List<String> paragraph = new ArrayList<>();
            while (index < lines.size()) {
                String current = lines.get(index);
                String currentTrimmed = current.strip();
                if (currentTrimmed.isEmpty() || currentTrimmed.startsWith("#")
                        || currentTrimmed.startsWith(">") || currentTrimmed.startsWith("|")
                        || currentTrimmed.equals("---")
                        || ORDERED_ITEM.matcher(current).matches()
                        || UNORDERED_ITEM.matcher(current).matches()) {
                    break;
                }
                paragraph.add(currentTrimmed);
                index++;
            }
            out.append("<p>").append(inline(String.join(" ", paragraph))).append("</p>\n");
        }
        return out.toString();
    }

    private static int renderList(List<String> lines, int start, StringBuilder out,
                                  String tag, Pattern itemPattern) {
        out.append('<').append(tag).append(">\n");
        int index = start;
        while (index < lines.size()) {
            Matcher matcher = itemPattern.matcher(lines.get(index));
            if (!matcher.matches()) {
                break;
            }
            StringBuilder item = new StringBuilder(matcher.group(1).strip());
            index++;
            // 续行：列表项后面跟着的、缩进更深且不是新列表项的行
            while (index < lines.size()) {
                String next = lines.get(index);
                boolean isNewItem = itemPattern.matcher(next).matches();
                if (next.strip().isEmpty() || isNewItem || !Character.isWhitespace(next.charAt(0))) {
                    break;
                }
                item.append(' ').append(next.strip());
                index++;
            }
            out.append("<li>").append(inline(item.toString())).append("</li>\n");
        }
        out.append("</").append(tag).append(">\n");
        return index;
    }

    private static int renderTable(List<String> lines, int start, StringBuilder out) {
        List<String> header = splitRow(lines.get(start));
        out.append("<table>\n<thead><tr>");
        header.forEach(cell -> out.append("<th>").append(inline(cell)).append("</th>"));
        out.append("</tr></thead>\n<tbody>\n");

        int index = start + 2;
        while (index < lines.size() && lines.get(index).strip().startsWith("|")) {
            out.append("<tr>");
            splitRow(lines.get(index)).forEach(cell ->
                    out.append("<td>").append(inline(cell)).append("</td>"));
            out.append("</tr>\n");
            index++;
        }
        out.append("</tbody>\n</table>\n");
        return index;
    }

    private static List<String> splitRow(String row) {
        String body = row.strip();
        if (body.startsWith("|")) {
            body = body.substring(1);
        }
        if (body.endsWith("|")) {
            body = body.substring(0, body.length() - 1);
        }
        List<String> cells = new ArrayList<>();
        for (String cell : body.split("\\|", -1)) {
            cells.add(cell.strip());
        }
        return cells;
    }

    /** 行内语法。先转义 HTML，再按占位符—替换—还原的顺序处理，避免嵌套互相破坏。 */
    private static String inline(String text) {
        String escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");

        List<String> codes = new ArrayList<>();
        Matcher codeMatcher = INLINE_CODE.matcher(escaped);
        StringBuilder withPlaceholders = new StringBuilder();
        while (codeMatcher.find()) {
            codes.add(codeMatcher.group(1));
            codeMatcher.appendReplacement(withPlaceholders,
                    Matcher.quoteReplacement("\u0000" + (codes.size() - 1) + "\u0000"));
        }
        codeMatcher.appendTail(withPlaceholders);
        escaped = withPlaceholders.toString();

        escaped = BOLD.matcher(escaped).replaceAll("<strong>$1</strong>");
        escaped = MARKDOWN_LINK.matcher(escaped).replaceAll("<a href=\"$2\">$1</a>");
        escaped = autoLink(escaped);

        for (int i = 0; i < codes.size(); i++) {
            escaped = escaped.replace("\u0000" + i + "\u0000", "<code>" + codes.get(i) + "</code>");
        }
        return escaped;
    }

    /** 裸 URL 自动成链，但跳过已经在标签里的部分（否则会把 href 也套一层）。 */
    private static String autoLink(String html) {
        StringBuilder out = new StringBuilder();
        int cursor = 0;
        while (cursor < html.length()) {
            int open = html.indexOf('<', cursor);
            int close = open < 0 ? -1 : html.indexOf('>', open);
            if (open < 0 || close < 0) {
                out.append(linkify(html.substring(cursor)));
                break;
            }
            out.append(linkify(html.substring(cursor, open)));
            out.append(html, open, close + 1);
            cursor = close + 1;
        }
        return out.toString();
    }

    private static String linkify(String text) {
        return BARE_URL.matcher(text).replaceAll("<a href=\"$0\">$0</a>");
    }
}
