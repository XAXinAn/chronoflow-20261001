/**
 * 滚轮日期选择器的纯计算（spec §4.1.7「跳到指定日期」）。
 *
 * 为什么不用月历：那个按钮点开又是一份和页面上一模一样的月历，等于白点。
 * 要跳「去年某天」这种跨年场景，滚轮（年 / 月 / 日 三列）比翻月历快得多。
 */

/** 年份列的默认跨度：以当前年为中心，前后各 10 年。 */
export const YEAR_SPAN = 10;

export function buildYearRange(centerYear: number, span: number = YEAR_SPAN): number[] {
  const years: number[] = [];
  for (let year = centerYear - span; year <= centerYear + span; year += 1) {
    years.push(year);
  }
  return years;
}

export function months(): number[] {
  return Array.from({ length: 12 }, (_, index) => index + 1);
}

/** 当月天数。闰年规则按公历：能被 4 整除但不能被 100 整除，或能被 400 整除。 */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

export function daysOfMonth(year: number, month: number): number[] {
  return Array.from({ length: daysInMonth(year, month) }, (_, index) => index + 1);
}

export function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 组装日期键，并把「日」夹到该月合法范围内。
 *
 * 不夹的话，从 1 月 31 日滚到 2 月会拼出一个不存在的「2 月 31 日」——
 * 提交给后端就是一个莫名其妙的 400。
 */
export function composeDateKey(year: number, month: number, day: number): string {
  const safeDay = Math.min(Math.max(day, 1), daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(safeDay)}`;
}

/** 把索引夹到 [0, length-1]：滚轮滚动结束时的取整结果可能越界一格。 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(Math.round(index), 0), length - 1);
}
