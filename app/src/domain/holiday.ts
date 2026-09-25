import type { HolidayResponse } from '../api/types';

/**
 * 节假日与调休的展示逻辑（spec §4.1.2 / §5.11）。
 *
 * 服务端只给「与常规周末不同的日子」：普通周六周日不在数据里。
 * 所以这里也不判断周末、不做任何兜底猜测——库里没有那一年，就一个标记都不显示，
 * 缺数据要能被看出来，而不是被前端悄悄编出来。
 */

export type HolidayMark = 'HOLIDAY' | 'WORKDAY';

/** 多份响应（跨年、或按月多次取）合并成「日期 → 标记」。 */
export function toHolidayMarks(responses: HolidayResponse[]): Map<string, HolidayMark> {
  const marks = new Map<string, HolidayMark>();
  for (const response of responses) {
    for (const day of response.days ?? []) {
      marks.set(day.date, day.dayType);
    }
  }
  return marks;
}

/** 日期 → 「休」/「班」；没有数据返回 null（而不是猜一个默认值）。 */
export function holidayBadge(mark: HolidayMark | undefined): string | null {
  if (mark === 'HOLIDAY') {
    return '休';
  }
  if (mark === 'WORKDAY') {
    return '班';
  }
  return null;
}

/** 名称查询：某天是中秋节就返回「中秋节」，否则 null。 */
export function holidayName(responses: HolidayResponse[], dateKey: string): string | null {
  for (const response of responses) {
    const hit = (response.days ?? []).find((day) => day.date === dateKey);
    if (hit) {
      return hit.name;
    }
  }
  return null;
}

/**
 * 日历网格会带出上/下月补位，可能跨年。
 * 返回网格覆盖到的年份，供调用方按年拉取节假日数据。
 */
export function yearsSpanned(startDateKey: string, endDateKey: string): number[] {
  const startYear = Number(startDateKey.slice(0, 4));
  const endYear = Number(endDateKey.slice(0, 4));
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year);
  }
  return years;
}
