/**
 * 重复规则（spec §4.1.2 / §4.1.4）：App 侧的纯逻辑。
 *
 * 服务端用 lib-recur（完整 RFC 5545）解析 `event.rrule`，所以这里只要**生成合法的 RRULE 字符串**、
 * 并能把已有的 RRULE 解析回界面状态（编辑时要能回填）。
 *
 * 为什么单独抽一个模块：RRULE 是「字符串 ↔ 界面控件」的双向映射，最容易出的错是
 * 生成的串服务端认不出、或者编辑一次就把用户的规则改掉（回填丢失）。这两件事都必须有单测盯着。
 */

export type Frequency = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type EndKind = 'NEVER' | 'UNTIL' | 'COUNT';

/** RFC 5545 的星期缩写，顺序固定为周一到周日（与 `Date.getUTCDay()` 的 0=周日不同）。 */
export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAY_CODES)[number];

export interface Recurrence {
  frequency: Frequency;
  /** 仅 WEEKLY 有意义：勾选了哪几天。空数组表示「与开始日同一天」。 */
  byWeekday: Weekday[];
  endKind: EndKind;
  /** `endKind === 'UNTIL'` 时使用，格式 `YYYY-MM-DD`（含当天）。 */
  untilDateKey: string | null;
  /** `endKind === 'COUNT'` 时使用，含首次，至少 1。 */
  count: number;
}

export const DEFAULT_COUNT = 10;

/** `YYYY-MM-DD` → 该日期是周几（Mon..Sun）。用 UTC 解析避免被设备时区带偏。 */
export function weekdayOf(dateKey: string): Weekday {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=周日
  return WEEKDAY_CODES[(index + 6) % 7] as Weekday;
}

/** 新建重复日程时的默认值：每周、勾上开始那天、永不结束。 */
export function defaultRecurrence(startDateKey: string): Recurrence {
  return {
    frequency: 'WEEKLY',
    byWeekday: [weekdayOf(startDateKey)],
    endKind: 'NEVER',
    untilDateKey: null,
    count: DEFAULT_COUNT,
  };
}

/** `YYYY-MM-DD` → `YYYYMMDD`（UNTIL 用日期形式，比带时刻更不容易因时区差一天）。 */
function compactDate(dateKey: string): string {
  return dateKey.replace(/-/g, '');
}

export function buildRrule(recurrence: Recurrence): string | null {
  if (recurrence.frequency === 'NONE') {
    return null;
  }
  const parts = [`FREQ=${recurrence.frequency}`];
  if (recurrence.frequency === 'WEEKLY') {
    // 显式写 BYDAY：不写的话服务端按「开始日是周几」推导，用户改了开始日、重复日会跟着变，
    // 而界面上的勾选看起来没变 —— 这类「改别处、这里悄悄变」的联动最难排查。
    const days = recurrence.byWeekday.length > 0
      ? WEEKDAY_CODES.filter((code) => recurrence.byWeekday.includes(code))
      : [];
    if (days.length > 0) {
      parts.push(`BYDAY=${days.join(',')}`);
    }
  }
  if (recurrence.endKind === 'UNTIL' && recurrence.untilDateKey) {
    parts.push(`UNTIL=${compactDate(recurrence.untilDateKey)}`);
  } else if (recurrence.endKind === 'COUNT') {
    parts.push(`COUNT=${Math.max(1, Math.floor(recurrence.count))}`);
  }
  return parts.join(';');
}

/** 把服务端已有的 RRULE 解析回界面状态；解析不出来就退回「不重复」，绝不猜。 */
export function parseRrule(rrule: string | null, startDateKey: string): Recurrence {
  if (!rrule) {
    return { frequency: 'NONE', byWeekday: [], endKind: 'NEVER', untilDateKey: null, count: DEFAULT_COUNT };
  }
  const map = new Map<string, string>();
  for (const chunk of rrule.split(';')) {
    const [key, value] = chunk.split('=');
    if (key && value) {
      map.set(key.trim().toUpperCase(), value.trim());
    }
  }
  // 认不出的 FREQ 一律退回「不重复」：宁可显示成不重复（用户一眼能看出并重设），
  // 也不要把一个服务端认不出的串原样回填、再原样提交上去
  const rawFrequency = (map.get('FREQ') ?? '').toUpperCase();
  const frequency: Frequency = (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).includes(
    rawFrequency as never,
  )
    ? (rawFrequency as Frequency)
    : 'NONE';
  const byWeekday = (map.get('BYDAY') ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code): code is Weekday => (WEEKDAY_CODES as readonly string[]).includes(code));

  const until = map.get('UNTIL');
  const count = map.get('COUNT');
  let endKind: EndKind = 'NEVER';
  let untilDateKey: string | null = null;
  let parsedCount = DEFAULT_COUNT;
  if (until) {
    // UNTIL 可能是 20261001 或 20261001T000000Z，两种都收
    const digits = until.replace(/[^0-9]/g, '').slice(0, 8);
    if (digits.length === 8) {
      endKind = 'UNTIL';
      untilDateKey = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  } else if (count) {
    const value = Number(count);
    if (Number.isFinite(value) && value > 0) {
      endKind = 'COUNT';
      parsedCount = Math.floor(value);
    }
  }
  if (frequency === 'WEEKLY' && byWeekday.length === 0) {
    // 服务端按开始日推导，回填时也要按同一口径显示，否则界面看起来「一天都没选」
    byWeekday.push(weekdayOf(startDateKey));
  }
  return { frequency, byWeekday, endKind, untilDateKey, count: parsedCount };
}

const WEEKDAY_LABEL: Record<Weekday, string> = {
  MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日',
};

/** 列表上显示的一句话，例如「每周一、三 · 共 5 次」。 */
export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.frequency === 'NONE') {
    return '不重复';
  }
  const base = recurrence.frequency === 'DAILY'
    ? '每天'
    : recurrence.frequency === 'MONTHLY'
      ? '每月'
      : recurrence.frequency === 'YEARLY'
        ? '每年'
        // 中文习惯：只在第一个前面写「周」——「每周一、三」而不是「每周一、周三」
        : `每周${WEEKDAY_CODES.filter((code) => recurrence.byWeekday.includes(code))
            .map((code) => WEEKDAY_LABEL[code].slice(1))
            .join('、')}`;
  const frequencyText = recurrence.frequency === 'WEEKLY' && recurrence.byWeekday.length === 0
    ? '每周'
    : base;
  if (recurrence.endKind === 'UNTIL' && recurrence.untilDateKey) {
    return `${frequencyText} · 直到 ${recurrence.untilDateKey}`;
  }
  if (recurrence.endKind === 'COUNT') {
    return `${frequencyText} · 共 ${Math.max(1, Math.floor(recurrence.count))} 次`;
  }
  return frequencyText;
}
