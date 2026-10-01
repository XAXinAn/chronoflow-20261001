import type { EventOccurrence, Task } from '../api/types';

/** 把 ISO 时间转成指定时区的 `YYYY-MM-DD`。 */
export function localDateKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface AgendaSection<T> {
  date: string;
  items: T[];
}

/** 按本地日期分组，并保持每组内按时间升序。 */
export function groupByDay<T>(
  items: T[],
  getStart: (item: T) => string,
  timeZone: string,
): AgendaSection<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = localDateKey(getStart(item), timeZone);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, group]) => ({
      date,
      items: [...group].sort((a, b) => getStart(a).localeCompare(getStart(b))),
    }));
}

export function groupOccurrences(items: EventOccurrence[], timeZone: string) {
  return groupByDay(items, (item) => item.at, timeZone);
}

/** 相对日期标签：今天 / 明天 / 昨天 / 周几 / 具体日期。 */
export function formatDayLabel(dateKey: string, todayKey: string): string {
  const diff = daysBetween(todayKey, dateKey);
  if (diff === 0) {
    return '今天';
  }
  if (diff === 1) {
    return '明天';
  }
  if (diff === -1) {
    return '昨天';
  }
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getUTCDay()];
  return Math.abs(diff) < 7 ? `${weekday}` : `${month} 月 ${day} 日`;
}

export function daysBetween(fromKey: string, toKey: string): number {
  const toUtc = (key: string) => {
    const [year, month, day] = key.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / 86_400_000);
}

const WEEKDAY_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 当日标题：`今天 · 9 月 25 日 周五`。
 *
 * 日历页与组织页共用同一份实现——两个 tab 的骨架都是「月历 + 当日日程」，
 * 标题口径不一致会让来回切换时产生割裂感。
 */
export function dayHeading(dateKey: string, todayKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAY_FULL[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const prefix = dateKey === todayKey ? '今天 · ' : '';
  return `${prefix}${month} 月 ${day} 日 ${weekday}`;
}

/**
 * 这个时刻是不是「只有日期、没有时刻」。
 *
 * <p>**这只是识别结果里的一个信号，不是展示口径**（2026-10-01 改）：
 * 日程只有一个时间点（spec §4.1.2），**00:00 就是一个普通的时间点，不再代表「全天 / 只说了哪天」**。
 * 会用到它的地方只有一处——图片识别的解析结果：模型按提示词的约定，把「只写了哪一天」
 * 输出成当地 00:00，客户端据此判断「时刻没识别出来」，填一个默认时刻并在备注里标注。
 */
export function isDateOnlyPoint(atIso: string, timeZone: string): boolean {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(new Date(atIso)) === '00:00';
}

/**
 * 日程时间的展示：永远是「HH:mm」，**00:00 也照实显示**。
 *
 * <p>以前这里对当地 00:00 返回 null（「只说了哪一天」→ 只显示日期），结果是用户
 * 把时间拨到 00:00 之后，列表里那一栏干脆空了——看起来就是「00:00 选不上」。
 * 现在时间点必须明确，00:00 就是凌晨零点。
 */
export function formatEventTime(atIso: string, timeZone: string): string {
  return timeInZoneByIntl(atIso, timeZone);
}

/**
 * 「什么时候的事」整串文案：`9 月 30 日 15:00`（通知正文用）。
 */
export function formatEventWhen(atIso: string, timeZone: string): string {
  const [, month, day] = localDateKey(atIso, timeZone).split('-').map(Number) as
    [number, number, number];
  return `${month} 月 ${day} 日 ${formatEventTime(atIso, timeZone)}`;
}

function timeInZoneByIntl(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * 地点展示文案（spec §5.9）：地图给的地点可能只到「教学楼」，
 * 用户手填的详细地址是它的补充；两者都可空。
 */
export function locationLabel(name: string | null, detail: string | null): string {
  const place = (name ?? '').trim();
  const extra = (detail ?? '').trim();
  if (place && extra) {
    return `${place}（${extra}）`;
  }
  return place || extra;
}

export function sortTasks(tasks: Task[]): Task[] {
  const priorityRank: Record<Task['priority'], number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  return [...tasks].sort((a, b) => {
    const doneA = a.status === 'DONE' ? 1 : 0;
    const doneB = b.status === 'DONE' ? 1 : 0;
    if (doneA !== doneB) {
      return doneA - doneB;
    }
    if (a.dueAt && b.dueAt) {
      return a.dueAt.localeCompare(b.dueAt);
    }
    if (a.dueAt) {
      return -1;
    }
    if (b.dueAt) {
      return 1;
    }
    return priorityRank[a.priority] - priorityRank[b.priority];
  });
}
