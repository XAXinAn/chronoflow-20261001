import type { SearchResultItem } from '../api/types';
import { formatTimeRange, localDateKey } from './agenda';
import { APP_TIMEZONE } from './calendar';

/**
 * 检索结果的展示逻辑（spec §4.1.7）。
 *
 * 服务端给的是一份**按时间倒序排好**的统一结果流（无时间的待办在最后），
 * 所以这里不再排序、也不把它拆成两段——按类型拆开就会把「最近的在前」这个承诺丢掉。
 * 类型靠每行前面的标签区分，这才是「结果按类型区分展示」的可读实现。
 */

export function resultTypeLabel(type: SearchResultItem['type']): string {
  return type === 'TASK' ? '待办' : '日程';
}

/** 展示用时区：优先取条目自己的（日程可能跨时区），否则用 App 统一时区。 */
export function resultTimeZone(item: SearchResultItem, fallback: string = APP_TIMEZONE): string {
  return item.timezone || fallback;
}

function formatDayTime(iso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(new Date(iso));
}

/** 副标题：日程是时间段 + 地点，待办是截止时间（没有就是「待安排」）。 */
export function resultSubtitle(item: SearchResultItem, fallback: string = APP_TIMEZONE): string {
  const timeZone = resultTimeZone(item, fallback);

  if (item.type === 'TASK') {
    const prefix = item.status === 'DONE' ? '已完成 · ' : '';
    if (!item.dueAt) {
      return `${prefix}待安排`;
    }
    return `${prefix}截止 ${formatDayTime(item.dueAt, timeZone)}`;
  }

  if (!item.startAt || !item.endAt) {
    // 服务端一定会给时间，缺了说明数据有问题——如实说明，别假装它是全天
    return '时间缺失';
  }
  const range = formatTimeRange(item.startAt, item.endAt, Boolean(item.allDay), timeZone);
  return item.locationName ? `${range} · ${item.locationName}` : range;
}

/** 结果行上的小标签。 */
export function resultBadges(item: SearchResultItem): string[] {
  const badges: string[] = [];
  if (item.recurring) {
    badges.push('重复');
  }
  if (item.type === 'TASK' && item.status === 'DONE') {
    badges.push('已完成');
  }
  return badges;
}

/**
 * 打开该结果时日历应选中的日期。
 *
 * 重复日程取的是**最近一次实例**的日期（服务端已经算好放在 startAt 里），
 * 打开时同时带上 occurrenceDate，才落在「这一次」而不是整条序列上。
 */
export function resultDateKey(item: SearchResultItem, fallback: string = APP_TIMEZONE): string | null {
  if (item.type !== 'EVENT' || !item.startAt) {
    return null;
  }
  return localDateKey(item.startAt, resultTimeZone(item, fallback));
}
