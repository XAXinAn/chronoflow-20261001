/**
 * 提醒的本地排期（spec §4.1.2 / §4.5）。
 *
 * 分工见 spec §4.5：**日程/待办的到点提醒走本地通知**（`expo-notifications` 在设备上排期），
 * 不依赖网络、不把设备标识交给第三方；服务端只负责保存提醒设置（`PUT /reminders`），
 * 以便换设备后重新排、以及将来接推送。
 *
 * 这里只算「该在什么时刻响几声」，不碰任何原生 API —— 于是可以在 node 里单测。
 * 三个必须守住的约束：
 *   1. **已经过去的时刻不要再排**（否则保存后立刻弹一堆过期提醒）；
 *   2. **iOS 待触发通知上限 64 条**，重复日程只排未来 30 天，并按上限截断；
 *   3. 到点提醒（提前 0 分钟）与全天日程的基准时刻要算对（全天按当地 09:00）。
 */

/** 界面上可选的提前量（分钟）。1440 = 提前 1 天。 */
export const REMINDER_PRESETS = [0, 5, 15, 30, 60, 1440] as const;

/** iOS 上限 64，留出余量给未来别的本地通知。 */
export const MAX_SCHEDULED_REMINDERS = 60;

/** 重复日程一次只排这么多天，之后靠「用户再次打开 App」时续排。 */
export const SCHEDULE_HORIZON_DAYS = 30;

/** 全天日程的提醒基准：当天这个钟点（当地时间）。 */
export const ALL_DAY_BASE_HOUR = 9;

export interface PlannedReminder {
  /** 触发时刻（绝对时间） */
  at: Date;
  /** 提前多少分钟（回显与去重用） */
  minutesBefore: number;
}

export interface PlanInput {
  /** 日程开始时刻（ISO 8601 带时区） */
  startAt: string;
  allDay: boolean;
  /** 日程自己的时区（如 Asia/Shanghai）；全天日程按它算 09:00 */
  timezone: string;
  minutesBefore: number[];
  /** 当前时刻，测试里注入固定值 */
  now: Date;
}

/**
 * 把「某天某点（某时区）」换算成绝对时刻。
 *
 * 不引时区库：用 `Intl` 反查该时刻在该时区的偏移，迭代两次收敛
 * （夏令时切换那天第一次 guess 会偏一小时，第二次就对了）。
 */
export function zonedTimeToUtc(dateKey: string, hour: number, timezone: string, minute = 0): Date {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = guess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = zoneOffsetMinutes(new Date(timestamp), timezone);
    timestamp = guess - offset * 60_000;
  }
  return new Date(timestamp);
}

/** 某时刻在某时区的偏移（分钟，东八区为 +480）。 */
export function zoneOffsetMinutes(at: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = formatter.formatToParts(at);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    pick('year'), pick('month') - 1, pick('day'),
    pick('hour') % 24, pick('minute'), pick('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** 某个日期键 + 时区下的当地 09:00 这类基准时刻。 */
export function reminderBase(input: Pick<PlanInput, 'startAt' | 'allDay' | 'timezone'>): Date {
  if (!input.allDay) {
    return new Date(Date.parse(input.startAt));
  }
  const offset = zoneOffsetMinutes(new Date(Date.parse(input.startAt)), input.timezone);
  const local = new Date(Date.parse(input.startAt) + offset * 60_000);
  const dateKey = [
    local.getUTCFullYear(),
    String(local.getUTCMonth() + 1).padStart(2, '0'),
    String(local.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return zonedTimeToUtc(dateKey, ALL_DAY_BASE_HOUR, input.timezone);
}

/**
 * 算出该排哪些本地通知：升序、去掉已过去、去重、按上限截断。
 */
export function planReminders(input: PlanInput): PlannedReminder[] {
  const base = reminderBase(input);
  const unique = [...new Set(input.minutesBefore.filter((minutes) => Number.isFinite(minutes) && minutes >= 0))];
  return unique
    .map((minutesBefore) => ({ at: new Date(base.getTime() - minutesBefore * 60_000), minutesBefore }))
    .filter((reminder) => reminder.at.getTime() > input.now.getTime())
    .sort((left, right) => left.at.getTime() - right.at.getTime())
    .slice(0, MAX_SCHEDULED_REMINDERS);
}

/** 重复日程的排期窗口上界（本地时间之后 N 天）。 */
export function horizonEnd(now: Date, days = SCHEDULE_HORIZON_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export function formatMinutesBefore(minutes: number): string {
  if (minutes <= 0) {
    return '到点';
  }
  if (minutes % 1440 === 0) {
    return `提前 ${minutes / 1440} 天`;
  }
  if (minutes % 60 === 0) {
    return `提前 ${minutes / 60} 小时`;
  }
  return `提前 ${minutes} 分钟`;
}
