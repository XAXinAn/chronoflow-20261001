import { describe, expect, it } from 'vitest';

import { createAgentStreamParser, type AgentStreamEvent } from '../src/domain/agentStream';

/**
 * 助手 SSE 分片解析（spec §11 阶段三）。
 *
 * 这些用例都是网络层的真实形状：一次 `read()` 可能只拿到半帧、也可能一次拿到三帧；
 * 帧之间用空行分隔、行尾可能是 `\r\n`。解析错了的表现是「偶尔丢字」，
 * 在真机上极难复现，所以必须在这里钉死。
 */
describe('助手流式解析', () => {
  const collect = (...chunks: string[]) => {
    const events: AgentStreamEvent[] = [];
    const parser = createAgentStreamParser((event) => events.push(event));
    chunks.forEach((chunk) => parser.push(chunk));
    parser.flush();
    return events;
  };

  it('一帧就是一次事件：delta 的文本原样吐出', () => {
    const events = collect(
      'event:delta\ndata:{"text":"你明天下午"}\n\n' + 'event:delta\ndata:{"text":"没有安排。"}\n\n',
    );

    expect(events).toEqual([
      { type: 'delta', text: '你明天下午' },
      { type: 'delta', text: '没有安排。' },
    ]);
  });

  it('跨 chunk 的半帧要拼起来再解析，不能吐半个事件', () => {
    const events = collect(
      'event:delta\ndata:{"text":"上',
      '午十点"}\n\nevent:delta\ndata:{"text":"可以"}\n\n',
    );

    expect(events).toEqual([
      { type: 'delta', text: '上午十点' },
      { type: 'delta', text: '可以' },
    ]);
  });

  it('一次拿到多个事件时按顺序全部处理', () => {
    const events = collect(
      'event:status\ndata:{"stage":"querying_events","label":"正在查日程…"}\n\n'
        + 'event:action\ndata:{"actionId":"a1","type":"create_event","summary":"创建日程：张总会","payload":{"title":"张总会"}}\n\n'
        + 'event:done\ndata:{"finishReason":"stop","usage":{"promptTokens":812,"completionTokens":96}}\n\n',
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'status', stage: 'querying_events', label: '正在查日程…' });
    expect(events[1]).toMatchObject({
      type: 'action',
      action: { actionId: 'a1', type: 'create_event', payload: { title: '张总会' } },
    });
    expect(events[2]).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 812, completionTokens: 96 },
    });
  });

  it('坏帧（半截 JSON / 非 JSON）直接丢掉，不把乱码渲染到界面', () => {
    const events = collect(
      'event:delta\ndata:{"text":"正常"}\n\n'
        + 'event:delta\ndata:{"text":半截\n\n'
        + 'event:delta\ndata:这不是 JSON\n\n'
        + 'event:delta\ndata:{"text":"还在"}\n\n',
    );

    expect(events).toEqual([
      { type: 'delta', text: '正常' },
      { type: 'delta', text: '还在' },
    ]);
  });

  it('error 事件带错误码与文案', () => {
    const events = collect('event:error\ndata:{"code":90002,"message":"助手模型未配置"}\n\n');

    expect(events).toEqual([{ type: 'error', code: 90002, message: '助手模型未配置' }]);
  });

  it('tool 事件：带人话摘要与可展开明细（不是原始 JSON）', () => {
    const events = collect(
      'event:tool\ndata:{"toolCallId":"call_1","name":"list_my_events",'
        + '"arguments":"{\\"keyword\\":\\"评审\\"}","result":"{\\"total\\":2}",'
        + '"readOnly":true,"summary":"已查日程 · 2 条",'
        + '"detail":["关键词「评审」","和张总开会 · 9/29 15:00"]}\n\n',
    );

    expect(events).toEqual([
      {
        type: 'tool',
        tool: {
          toolCallId: 'call_1',
          name: 'list_my_events',
          arguments: '{"keyword":"评审"}',
          result: '{"total":2}',
          readOnly: true,
          summary: '已查日程 · 2 条',
          detail: ['关键词「评审」', '和张总开会 · 9/29 15:00'],
        },
      },
    ]);
  });

  it('tool 事件缺摘要的坏帧直接丢掉，不给界面添乱', () => {
    const events = collect('event:tool\ndata:{"name":"list_my_events"}\n\n');
    expect(events).toEqual([]);
  });

  it('容忍 CRLF 行尾与注释行，忽略 [DONE]', () => {
    const events = collect(
      ': keep-alive\r\n\r\nevent:delta\r\ndata:{"text":"好"}\r\n\r\ndata: [DONE]\r\n\r\n',
    );

    expect(events).toEqual([{ type: 'delta', text: '好' }]);
  });

  it('流结束时把缓冲区里最后一帧也解析出来', () => {
    const events: AgentStreamEvent[] = [];
    const parser = createAgentStreamParser((event) => events.push(event));
    // 服务端最后一帧后没有空行（连接直接关掉）
    parser.push('event:done\ndata:{"finishReason":"stop"}');
    expect(events).toHaveLength(0);
    parser.flush();
    expect(events).toEqual([{ type: 'done', finishReason: 'stop', usage: null }]);
  });
});
