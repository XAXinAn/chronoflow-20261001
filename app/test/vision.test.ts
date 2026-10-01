import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildDraftCreatePayload,
  draftDateKey,
  draftsFromItems,
  missingDateCount,
  normalizeTime,
} from '../src/domain/vision';

/**
 * 「图片识别日程」链路里**能单测的一段**：服务端返回的草稿如何归一、确认页上的草稿
 * 如何映射成创建请求。端侧 OCR 与云端解析各自有自己的测试（Java / Python）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VISION_PROMPT = resolve(
  HERE,
  '../../backend-java/xa-agent/src/main/resources/agent/vision-prompt.md',
);

describe('识别草稿的归一', () => {
  it('吃下服务端 items：保留日期、丢弃空字段、没标题的条目不要', () => {
    const drafts = draftsFromItems([
      {
        title: '离返校登记',
        at: '2026-09-24T00:00:00+08:00',
        timezone: 'Asia/Shanghai',
        description: '学工系统完成登记',
      },
      // 没日期是合法结果：照样保留，dateKey 为 null，交给确认页补
      { title: '填写返校情况统计表', timezone: 'Asia/Shanghai' },
      // 没标题的条目没法确认也没法建，丢掉
      { title: '   ', at: '2026-09-24T00:00:00+08:00' },
    ]);

    expect(drafts).toHaveLength(2);
    expect(drafts[0].title).toBe('离返校登记');
    expect(drafts[0].at).toBe('2026-09-24T00:00:00+08:00');
    expect(drafts[1].at ?? null).toBeNull();
  });

  it('日期落在哪一天：用草稿自己的时区解释，没日期给 null', () => {
    expect(draftDateKey({ title: 'a', at: '2026-09-24T00:00:00+08:00' })).toBe('2026-09-24');
    // 跨时区：同一时刻在上海是 9/24，在 UTC 是 9/23——按草稿回带的时区算
    expect(draftDateKey({ title: 'a', at: '2026-09-23T16:00:00Z', timezone: 'Asia/Shanghai' }))
      .toBe('2026-09-24');
    expect(draftDateKey({ title: 'a', at: null })).toBeNull();
    expect(draftDateKey({ title: 'a', at: '下周三' })).toBeNull();
  });

  it('没日期的条数用于「还有 x 条没选日期」', () => {
    expect(missingDateCount([
      { title: 'a', at: '2026-09-24T00:00:00+08:00' },
      { title: 'b' },
      { title: 'c', at: null },
    ])).toBe(2);
  });
});

describe('草稿 → 创建日程请求', () => {
  it('日期空不放行：草稿没日期时 dateKey 为 null，调用方据此禁用「添加」', () => {
    expect(draftDateKey({ title: '返校统计' })).toBeNull();
  });

  it('时刻固定当天 00:00、时区原样带上——「就这一天」', () => {
    const payload = buildDraftCreatePayload(
      { title: '  离返校登记  ', locationName: '学工系统', description: '9 月 24 日前' },
      '2026-09-24',
    );

    expect(payload.title).toBe('离返校登记');
    expect(payload.at).toBe('2026-09-24T00:00:00+08:00');
    expect(payload.timezone).toBe('Asia/Shanghai');
    expect(payload.locationName).toBe('学工系统');
  });

  it('空的地点 / 说明送 null，而不是空串（服务端把空串当有效值存）', () => {
    const payload = buildDraftCreatePayload({ title: '开会', locationName: '  ' }, '2026-09-24');
    expect(payload.locationName).toBeNull();
    expect(payload.description).toBeNull();
  });
});

describe('时间的容错归一', () => {
  it('带偏移量的 ISO 原样认；只有日期补当天 00:00', () => {
    expect(normalizeTime('2026-09-24T00:00:00+08:00')).toBe('2026-09-24T00:00:00+08:00');
    expect(normalizeTime('2026-09-24')).toBe('2026-09-24T00:00:00+08:00');
    expect(normalizeTime('2026-09-24 09:30')).toBe('2026-09-24T09:30:00+08:00');
  });

  it('编出来的时间不认：宁可空着，也不要一个猜错的时间', () => {
    expect(normalizeTime('下周三')).toBeNull();
    expect(normalizeTime('2026/09/24')).toBeNull();
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime(null)).toBeNull();
  });
});

describe('抽取提示词不变量（服务端那份，Java/Python 逐字节相同）', () => {
  // 抽取口径全在服务端的 `agent/vision-prompt.md` 里（App 自己不再持有提示词）。
  // 这里钉住三条产品口径：别让「中秋假期」这种叙述性内容混进草稿。
  const prompt = readFileSync(VISION_PROMPT, 'utf8');

  it('只抽「要做的事」，日期没有就留空，不猜时刻', () => {
    expect(prompt).toContain('要你做的事');
    expect(prompt).toContain('没写就留空');
    expect(prompt).toContain('不要猜时刻');
  });
});
