/**
 * 日历网格的纯日期计算。
 *
 * 刻意只用 UTC 做日期加减：Date 的本地时区语义在夏令时切换时会让「加一天」出错，
 * 而 UTC 没有夏令时，日期网格永远稳定。
 */

export interface MonthGridCell {
  /** YYYY-MM-DD */
  dateKey: string;
  day: number;
  inMonth: boolean;
}

export interface MonthGrid {
  year: number;
  month: number;
  weeks: MonthGridCell[][];
  /** 网格首日（可能属于上个月） */
  startDateKey: string;
  /** 网格末日（可能属于下个月） */
  endDateKey: string;
}

/** 中国采用固定 UTC+8，无夏令时，因此可以直接拼偏移量。 */
export const APP_TIMEZONE = 'Asia/Shanghai';
export const APP_UTC_OFFSET = '+08:00';

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function toKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * 生成月视图网格：固定 6 行 × 7 列，周一为一周起点（中文习惯）。
 */
export function buildMonthGrid(year: number, month: number): MonthGrid {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // getUTCDay(): 0=周日；转成「周一为 0」的偏移量
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month - 1, 1 - offset));

  const weeks: MonthGridCell[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const row: MonthGridCell[] = [];
    for (let day = 0; day < 7; day += 1) {
      const current = new Date(start);
      current.setUTCDate(start.getUTCDate() + week * 7 + day);
      row.push({
        dateKey: toKey(current),
        day: current.getUTCDate(),
        inMonth: current.getUTCMonth() + 1 === month,
      });
    }
    weeks.push(row);
  }

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 41);

  return { year, month, weeks, startDateKey: toKey(start), endDateKey: toKey(end) };
}

/** 月份加减，跨年自动处理。 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** 把日期键转成带时区偏移的 ISO 时刻，用于范围查询。 */
export function dateKeyToIso(dateKey: string, endOfDay = false): string {
  const time = endOfDay ? '23:59:59' : '00:00:00';
  return `${dateKey}T${time}${APP_UTC_OFFSET}`;
}

export function monthLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;
