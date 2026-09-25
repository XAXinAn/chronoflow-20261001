import { describe, expect, it } from 'vitest';

import { buildMonthGrid } from '../src/domain/calendar';

/**
 * 月历网格（spec §4.1.7 相关的日历渲染）。
 *
 * 这里的断言都针对一个被真实指出的 bug：固定 6 行会把整周不属于本月的那一周也画进月视图，
 * 于是「9 月」里出现了一整周 10 月——用户看到的不是这个月的日历。
 */
describe('月历网格', () => {
  it('2026 年 9 月只需要 5 行：8/31 起、10/4 止，不含整周属于 10 月的 10/5–10/11', () => {
    const grid = buildMonthGrid(2026, 9);

    expect(grid.weeks).toHaveLength(5);
    expect(grid.startDateKey).toBe('2026-08-31');
    expect(grid.endDateKey).toBe('2026-10-04');
    const allKeys = grid.weeks.flat().map((cell) => cell.dateKey);
    expect(allKeys).not.toContain('2026-10-05');
    expect(allKeys).not.toContain('2026-10-11');
  });

  it('补位的那一周只要含本月日期就保留（9 月最后一行含 9/28–9/30）', () => {
    const grid = buildMonthGrid(2026, 9);
    const lastWeek = grid.weeks.at(-1) ?? [];

    expect(lastWeek.map((cell) => cell.inMonth)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('确实需要 6 行的月份仍是 6 行：2026 年 8 月（8/1 是周六，8/31 是周一）', () => {
    const grid = buildMonthGrid(2026, 8);

    expect(grid.weeks).toHaveLength(6);
    expect(grid.startDateKey).toBe('2026-07-27');
    expect(grid.endDateKey).toBe('2026-09-06');
  });

  it('每个月第一格都是周一、最后一格都是周日，且首尾都含本月日期', () => {
    for (let month = 1; month <= 12; month += 1) {
      const grid = buildMonthGrid(2026, month);
      const cells = grid.weeks.flat();

      expect(cells).toHaveLength(grid.weeks.length * 7);
      expect([5, 6]).toContain(grid.weeks.length);
      expect(cells[0]?.dateKey).toBe(grid.startDateKey);
      expect(cells.at(-1)?.dateKey).toBe(grid.endDateKey);
      // 首行与末行都必须含本月日期，否则那一行就不该画
      expect((grid.weeks[0] ?? []).some((cell) => cell.inMonth)).toBe(true);
      expect((grid.weeks.at(-1) ?? []).some((cell) => cell.inMonth)).toBe(true);
    }
  });
});
