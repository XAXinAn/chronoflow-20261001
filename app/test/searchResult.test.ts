import { describe, expect, it } from 'vitest';

import type { SearchResultItem } from '../src/api/types';
import { resultBadges, resultDateKey, resultSubtitle, resultTypeLabel } from '../src/domain/search';

function item(partial: Partial<SearchResultItem>): SearchResultItem {
  return { type: 'EVENT', id: 1, title: '标题', ...partial };
}

describe('检索结果展示（spec §4.1.7）', () => {
  it('类型标签区分日程与待办', () => {
    expect(resultTypeLabel('EVENT')).toBe('日程');
    expect(resultTypeLabel('TASK')).toBe('待办');
  });

  it('待办没有截止时间就是「待安排」，已完成也如实标出', () => {
    expect(resultSubtitle(item({ type: 'TASK' }))).toBe('待安排');
    expect(resultSubtitle(item({ type: 'TASK', status: 'DONE' }))).toBe('已完成 · 待安排');
  });

  it('待办按 App 统一时区展示截止时间，不跟随设备时区', () => {
    // 10-05 10:00Z 在北京是 18:00；设备时区变了这里也不该变
    const subtitle = resultSubtitle(item({ type: 'TASK', dueAt: '2026-10-05T10:00:00Z' }));

    expect(subtitle).toContain('截止');
    expect(subtitle).toContain('18:00');
  });

  it('日程副标题是一个时间点加地点，并按条目自己的时区展示', () => {
    const subtitle = resultSubtitle(
      item({
        at: '2026-10-05T01:00:00Z',
        timezone: 'Asia/Shanghai',
        locationName: '会议室 A',
      }),
    );

    expect(subtitle).toBe('09:00 · 会议室 A');
    // 只说了哪一天（当地 00:00）：不显示时刻，只留地点
    expect(
      resultSubtitle(
        item({
          at: '2026-10-04T16:00:00Z',
          locationName: '会议室 A',
        }),
      ),
    ).toBe('会议室 A');
  });

  it('命中重复日程时带「重复」标签，且打开的是最近一次实例的日期', () => {
    const recurring = item({
      at: '2026-09-28T01:00:00Z',
      timezone: 'Asia/Shanghai',
      recurring: true,
      occurrenceDate: '2026-09-28',
    });

    expect(resultBadges(recurring)).toEqual(['重复']);
    // 这一步很关键：日期取的是实例时间而不是原始序列起点，否则点进去会跳到几个月前
    expect(resultDateKey(recurring)).toBe('2026-09-28');
  });

  it('待办结果没有可打开的日期', () => {
    expect(resultDateKey(item({ type: 'TASK' }))).toBeNull();
  });
});
