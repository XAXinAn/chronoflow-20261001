import { describe, expect, it } from 'vitest';

import {
  agentMarkdownToPlainText,
  parseAgentMarkdown,
  parseAgentInline,
} from '../src/domain/agentMarkdown';

/**
 * 助手回复的轻量 Markdown（spec §11 阶段三）。
 *
 * 重点是**只认我们认识的那几种**：模型偶尔吐出表格、链接、HTML 时，
 * 界面上应当原样显示成普通文字，而不是渲染出意外的东西。
 */
describe('行内解析', () => {
  it('识别粗体与行内代码', () => {
    expect(parseAgentInline('明天 **15:00** 有会，地点在 `会议室 A`')).toEqual([
      { type: 'text', text: '明天 ' },
      { type: 'bold', text: '15:00' },
      { type: 'text', text: ' 有会，地点在 ' },
      { type: 'code', text: '会议室 A' },
    ]);
  });

  it('没配对的标记按普通文本处理，不吞掉后面的字', () => {
    expect(parseAgentInline('2 ** 3 等于 8')).toEqual([{ type: 'text', text: '2 ** 3 等于 8' }]);
    expect(parseAgentInline('反引号 ` 没配对')).toEqual([{ type: 'text', text: '反引号 ` 没配对' }]);
  });
});

describe('块级解析', () => {
  it('分段、列表、引用各归各位', () => {
    const blocks = parseAgentMarkdown(
      '明天下午的安排：\n\n- 15:00 张总会\n- 17:00 复盘\n\n1. 先改标题\n2. 再存提醒\n\n> 需要我帮你建一条吗',
    );

    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'bullet',
      'ordered',
      'quote',
    ]);
  });

  it('列表项紧挨着写也算列表（模型很少给空行）', () => {
    const blocks = parseAgentMarkdown('- 周一\n- 周二');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'bullet' });
  });

  it('不安全 / 不支持的输入按纯文本显示', () => {
    // 链接、HTML、表格都不在子集里：全部当普通文字，不渲染成可点的链接或标签
    expect(agentMarkdownToPlainText('[点我](https://example.com)')).toBe(
      '[点我](https://example.com)',
    );
    expect(agentMarkdownToPlainText('<b>加粗</b>')).toBe('<b>加粗</b>');
    expect(parseAgentMarkdown('# 一级标题')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: '# 一级标题' }]] },
    ]);
  });

  it('纯文本导出给「长按复制」，把标记符号去掉', () => {
    expect(agentMarkdownToPlainText('**15:00** 见\n- 带上电脑')).toBe('15:00 见\n- 带上电脑');
  });

  it('空文本不炸', () => {
    expect(parseAgentMarkdown('')).toEqual([]);
    expect(agentMarkdownToPlainText('')).toBe('');
  });
});
