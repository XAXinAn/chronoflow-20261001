import type { EventOccurrence, OrgEvent, ReceiptStatus, Task } from '../api/types';

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

/** 按本地日期分组，并保持每组内按开始时间升序。 */
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
  return groupByDay(items, (item) => item.startAt, timeZone);
}

export function groupOrgEvents(items: OrgEvent[], timeZone: string) {
  return groupByDay(items, (item) => item.startAt, timeZone);
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

/** 时间范围展示：全天不显示具体时刻。 */
export function formatTimeRange(startIso: string, endIso: string, allDay: boolean, timeZone: string): string {
  if (allDay) {
    return '全天';
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${formatter.format(new Date(startIso))} – ${formatter.format(new Date(endIso))}`;
}

const RECEIPT_LABELS: Record<ReceiptStatus, string> = {
  PENDING: '待回执',
  ACCEPTED: '已参加',
  DECLINED: '不参加',
  COMPLETED: '已完成',
};

export function receiptLabel(status: ReceiptStatus | null): string {
  return status ? RECEIPT_LABELS[status] : '—';
}

/** 待办排序：未完成在前，其次按截止时间（无时间排最后），再按优先级。 */
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
