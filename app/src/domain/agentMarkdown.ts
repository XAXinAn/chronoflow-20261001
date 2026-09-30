/**
 * 轻量 Markdown 子集（spec §11 阶段三）。
 *
 * <p>为什么自己写而不是引库：助手的输出被提示词限制在很小的一个子集里
 * （粗体、行内代码、无序 / 有序列表、引用、换行），引一个通用 Markdown 渲染器
 * 既要多一套原生依赖，又会让「模型偶尔吐出来的表格 / 链接 / HTML」变成界面上的意外。
 * 这里只认我们认识的那几种，**其余一律按纯文本显示**——不会因为模型多写一个字符
 * 就渲染出奇怪的东西。
 *
 * <p>纯逻辑：只有 `parseAgentMarkdown` 一个函数，解析结果交给组件渲染。
 */

export type AgentInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string };

export type AgentBlock =
  | { type: 'paragraph'; lines: AgentInline[][] }
  | { type: 'bullet'; items: AgentInline[][] }
  | { type: 'ordered'; items: AgentInline[][] }
  | { type: 'quote'; lines: AgentInline[][] };

/** 行内解析：`**粗体**` 与 `` `代码` ``，没配对的一律当普通文本。 */
export function parseAgentInline(source: string): AgentInline[] {
  const parts: AgentInline[] = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (buffer) {
      parts.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  while (index < source.length) {
    const rest = source.slice(index);
    if (rest.startsWith('**')) {
      const end = source.indexOf('**', index + 2);
      if (end > index + 2) {
        flush();
        parts.push({ type: 'bold', text: source.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }
    if (rest.startsWith('`')) {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        parts.push({ type: 'code', text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    buffer += source[index];
    index += 1;
  }
  flush();
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

const BULLET = /^[-*•]\s+(.*)$/;
const ORDERED = /^\d+[.、)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/**
 * 块级解析。
 *
 * <p>连续的行按类型分组成块；空行结束当前块。列表项之间不再需要空行——
 * 模型给的列表常常紧挨着写，严格要求空行会把它降级成一坨文字。
 */
export function parseAgentMarkdown(source: string): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  const lines = (source ?? '').replace(/\r\n|\r/g, '\n').split('\n');

  let paragraph: AgentInline[][] = [];
  let bullet: AgentInline[][] = [];
  let ordered: AgentInline[][] = [];
  let quote: AgentInline[][] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', lines: paragraph });
      paragraph = [];
    }
    if (bullet.length > 0) {
      blocks.push({ type: 'bullet', items: bullet });
      bullet = [];
    }
    if (ordered.length > 0) {
      blocks.push({ type: 'ordered', items: ordered });
      ordered = [];
    }
    if (quote.length > 0) {
      blocks.push({ type: 'quote', lines: quote });
      quote = [];
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const bulletMatch = BULLET.exec(line);
    if (bulletMatch) {
      if (paragraph.length > 0 || ordered.length > 0 || quote.length > 0) {
        flush();
      }
      bullet.push(parseAgentInline(bulletMatch[1]));
      continue;
    }
    const orderedMatch = ORDERED.exec(line);
    if (orderedMatch) {
      if (paragraph.length > 0 || bullet.length > 0 || quote.length > 0) {
        flush();
      }
      ordered.push(parseAgentInline(orderedMatch[1]));
      continue;
    }
    const quoteMatch = QUOTE.exec(line);
    if (quoteMatch) {
      if (paragraph.length > 0 || bullet.length > 0 || ordered.length > 0) {
        flush();
      }
      quote.push(parseAgentInline(quoteMatch[1]));
      continue;
    }
    // 普通文本：接着上一段写（模型换行不等于新段落）
    if (bullet.length > 0 || ordered.length > 0 || quote.length > 0) {
      flush();
    }
    paragraph.push(parseAgentInline(line));
  }
  flush();
  return blocks;
}

/** 拿到纯文本（用于「长按复制」与无障碍朗读），去掉所有标记符号。 */
export function agentMarkdownToPlainText(source: string): string {
  return parseAgentMarkdown(source)
    .map((block) => {
      switch (block.type) {
        case 'paragraph':
          return block.lines.map(joinInline).join('\n');
        case 'quote':
          return block.lines.map((line) => `> ${joinInline(line)}`).join('\n');
        case 'bullet':
          return block.items.map((item) => `- ${joinInline(item)}`).join('\n');
        case 'ordered':
          return block.items.map((item, index) => `${index + 1}. ${joinInline(item)}`).join('\n');
      }
    })
    .join('\n');
}

function joinInline(parts: AgentInline[]): string {
  return parts.map((part) => part.text).join('');
}
