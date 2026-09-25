import { APP_UTC_OFFSET } from './calendar';

export interface EventDraft {
  title: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
}

export const DEFAULT_START_TIME = '09:00';
export const DEFAULT_END_TIME = '10:00';

export function emptyDraft(): EventDraft {
  return { title: '', startTime: DEFAULT_START_TIME, endTime: DEFAULT_END_TIME, allDay: false };
}

/** HH:mm 解析；非法返回 null。 */
export function parseTime(value: string): { hour: number; minute: number } | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) {
    return null;
  }
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 把日期键 + HH:mm 拼成带时区偏移的 ISO 时刻（中国固定 UTC+8，无夏令时）。 */
export function toIso(dateKey: string, time: string): string {
  const parsed = parseTime(time);
  if (!parsed) {
    throw new Error(`时间格式非法: ${time}`);
  }
  return `${dateKey}T${pad(parsed.hour)}:${pad(parsed.minute)}:00${APP_UTC_OFFSET}`;
}

/** 开始时间 + 分钟数，得到默认结束时间。 */
export function addMinutes(time: string, minutes: number): string {
  const parsed = parseTime(time);
  if (!parsed) {
    return DEFAULT_END_TIME;
  }
  const total = parsed.hour * 60 + parsed.minute + minutes;
  return `${pad(Math.floor((total % 1440) / 60))}:${pad(total % 60)}`;
}

export type DraftValidation = { ok: true } | { ok: false; message: string };

/**
 * 校验草稿。全天日程不校验时刻，只要求标题非空。
 */
export function validateDraft(draft: EventDraft): DraftValidation {
  if (!draft.title.trim()) {
    return { ok: false, message: '请填写标题' };
  }
  if (draft.allDay) {
    return { ok: true };
  }
  const start = parseTime(draft.startTime);
  const end = parseTime(draft.endTime);
  if (!start) {
    return { ok: false, message: '开始时间格式应为 HH:mm' };
  }
  if (!end) {
    return { ok: false, message: '结束时间格式应为 HH:mm' };
  }
  if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) {
    return { ok: false, message: '结束时间需晚于开始时间' };
  }
  return { ok: true };
}

/**
 * 组装创建日程的请求体。
 *
 * 全天日程按「当天 00:00 到次日 00:00」提交，与后端 end_at > start_at 的约束一致。
 */
export function buildCreatePayload(dateKey: string, draft: EventDraft) {
  if (draft.allDay) {
    const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const nextKey = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
    return {
      title: draft.title.trim(),
      startAt: toIso(dateKey, '00:00'),
      endAt: toIso(nextKey, '00:00'),
      allDay: true,
    };
  }
  return {
    title: draft.title.trim(),
    startAt: toIso(dateKey, draft.startTime),
    endAt: toIso(dateKey, draft.endTime),
    allDay: false,
  };
}
