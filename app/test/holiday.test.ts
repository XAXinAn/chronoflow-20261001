import { describe, expect, it } from 'vitest';

import type { HolidayResponse } from '../src/api/types';
import { holidayBadge, holidayName, toHolidayMarks, yearsSpanned } from '../src/domain/holiday';

const SEPTEMBER_2026: HolidayResponse = {
  country: 'zh-CN',
  year: 2026,
  month: 9,
  days: [
    { date: '2026-09-25', name: '中秋节', dayType: 'HOLIDAY' },
    { date: '2026-09-27', name: '中秋节', dayType: 'WORKDAY' },
  ],
};

describe('节假日标记（spec §4.1.2 / §5.11）', () => {
  it('多份响应合并成「日期 → 标记」的映射', () => {
    const marks = toHolidayMarks([
      SEPTEMBER_2026,
      { country: 'zh-CN', year: 2026, days: [{ date: '2026-10-01', name: '国庆节', dayType: 'HOLIDAY' }] },
    ]);

    expect(marks.get('2026-09-25')).toBe('HOLIDAY');
    expect(marks.get('2026-09-27')).toBe('WORKDAY');
    expect(marks.get('2026-10-01')).toBe('HOLIDAY');
  });

  it('休 / 班 的标签，没有数据就是 null（不猜）', () => {
    expect(holidayBadge('HOLIDAY')).toBe('休');
    expect(holidayBadge('WORKDAY')).toBe('班');
    // 普通周末不在数据里——库与响应都没有，就什么都不显示
    expect(holidayBadge(undefined)).toBeNull();
  });

  it('按日期查节日名称', () => {
    expect(holidayName([SEPTEMBER_2026], '2026-09-25')).toBe('中秋节');
    expect(holidayName([SEPTEMBER_2026], '2026-09-26')).toBeNull();
  });

  it('按网格跨度列出年份：跨年的补位格子也要拿到数据', () => {
    expect(yearsSpanned('2025-12-29', '2026-02-08')).toEqual([2025, 2026]);
    expect(yearsSpanned('2026-09-28', '2026-11-08')).toEqual([2026]);
  });
});
