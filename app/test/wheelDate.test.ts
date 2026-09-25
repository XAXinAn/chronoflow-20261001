import { describe, expect, it } from 'vitest';

import {
  buildYearRange,
  clampIndex,
  composeDateKey,
  daysInMonth,
  parseDateKey,
} from '../src/domain/wheelDate';

describe('滚轮日期选择器的计算（spec §4.1.7）', () => {
  it('年份列以当前年为中心', () => {
    const years = buildYearRange(2026, 2);
    expect(years).toEqual([2024, 2025, 2026, 2027, 2028]);
  });

  it('每月天数按公历闰年规则', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29); // 能被 4 整除
    expect(daysInMonth(2100, 2)).toBe(28); // 能被 100 整除但不能被 400 整除
    expect(daysInMonth(2000, 2)).toBe(29); // 能被 400 整除
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it('日超界会被夹到当月最后一天，而不是拼出不存在的日期', () => {
    // 1/31 滚到 2 月：不能出现「2 月 31 日」
    expect(composeDateKey(2026, 2, 31)).toBe('2026-02-28');
    expect(composeDateKey(2028, 2, 31)).toBe('2028-02-29');
    expect(composeDateKey(2026, 4, 31)).toBe('2026-04-30');
    // 正常范围原样输出，且补零
    expect(composeDateKey(2026, 9, 5)).toBe('2026-09-05');
  });

  it('日期键可来回解析', () => {
    expect(parseDateKey(composeDateKey(2026, 9, 25))).toEqual({ year: 2026, month: 9, day: 25 });
  });

  it('滚轮停下时的取整结果要夹到合法索引', () => {
    expect(clampIndex(2.4, 10)).toBe(2);
    expect(clampIndex(-1, 10)).toBe(0);
    expect(clampIndex(99, 10)).toBe(9);
    expect(clampIndex(3, 0)).toBe(0);
  });
});
