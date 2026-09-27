import type { EventAvailability, EventDetail, EventStatus, Priority } from '../api/types';
import { localDateKey } from './agenda';
import { APP_UTC_OFFSET } from './calendar';

/** 已选地点。坐标可空——手工输入的地点只有名字。 */
export interface EventPlace {
  poiId: string | null;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * 新建日程草稿。字段对齐主流系统日历（spec §4.1.4）。
 *
 * 日期不在这里：它由「你在日历上选中的那天」决定，少一个控件就少一次误操作。
 */
export interface EventDraft {
  title: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  place: EventPlace | null;
  /** 详细地址：地图只到「教学楼」，教室号由用户手填（与地点都可空，spec §5.9） */
  locationDetail: string;
  description: string;
  url: string;
  category: string;
  priority: Priority;
  availability: EventAvailability;
  status: EventStatus;
  /** 出行时间用文本保存，避免用户边输边被 Number('') 变成 0 */
  travelTimeMinutes: string;
  /**
   * 重复规则（RFC 5545）。空串 = 不重复。
   *
   * 存字符串而不是结构化对象：它就是要提交给服务端的东西，中间再转一层只会多一处走形的地方；
   * 生成与解析都在 domain/recurrence.ts 里，有单测盯着往返一致。
   */
  rrule: string;
  /** 本地提醒的提前量（分钟）。服务端也存一份（PUT /reminders），用于换设备后重排。 */
  reminders: number[];
}

export const DEFAULT_START_TIME = '09:00';
export const DEFAULT_END_TIME = '10:00';

export const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'LOW', label: '低' },
  { value: 'NORMAL', label: '普通' },
  { value: 'HIGH', label: '重要' },
  { value: 'URGENT', label: '紧急' },
];

export const AVAILABILITY_OPTIONS: { value: EventAvailability; label: string }[] = [
  { value: 'BUSY', label: '忙碌' },
  { value: 'FREE', label: '空闲' },
];

export const STATUS_OPTIONS: { value: EventStatus; label: string }[] = [
  { value: 'CONFIRMED', label: '已确认' },
  { value: 'TENTATIVE', label: '待定' },
];

export function emptyDraft(): EventDraft {
  return {
    title: '',
    startTime: DEFAULT_START_TIME,
    endTime: DEFAULT_END_TIME,
    allDay: false,
    place: null,
    locationDetail: '',
    description: '',
    url: '',
    category: '',
    priority: 'NORMAL',
    availability: 'BUSY',
    status: 'CONFIRMED',
    travelTimeMinutes: '',
    rrule: '',
    reminders: [],
  };
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

/** 出行时间：空串表示不设置，其余必须是 0-1440 的整数分钟。 */
export function parseTravelTime(value: string): { ok: true; minutes: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, minutes: null };
  }
  if (!/^\d{1,4}$/.test(trimmed)) {
    return { ok: false };
  }
  const minutes = Number(trimmed);
  if (minutes > 1440) {
    return { ok: false };
  }
  return { ok: true, minutes };
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
  const url = draft.url.trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
    return { ok: false, message: '链接需以 http:// 或 https:// 开头' };
  }
  const travel = parseTravelTime(draft.travelTimeMinutes);
  if (!travel.ok) {
    return { ok: false, message: '出行时间需为 0-1440 的分钟数' };
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
 * 空的文本字段统一送 null：后端用 null 表示「未设置」，空串会被当成有效值存进去。
 */
export function buildCreatePayload(dateKey: string, draft: EventDraft) {
  const travel = parseTravelTime(draft.travelTimeMinutes);
  const timeRange = draft.allDay
    ? {
        startAt: toIso(dateKey, '00:00'),
        endAt: toIso(nextDateKey(dateKey), '00:00'),
        allDay: true,
      }
    : {
        startAt: toIso(dateKey, draft.startTime),
        endAt: toIso(dateKey, draft.endTime),
        allDay: false,
      };

  return {
    title: draft.title.trim(),
    ...timeRange,
    description: blankToNull(draft.description),
    locationName: draft.place?.name ?? null,
    locationAddress: draft.place?.address ?? null,
    // 详细地址与地点互相独立：清空地点不该顺手把用户手写的教室号也清掉（spec §5.9）
    locationDetail: blankToNull(draft.locationDetail),
    latitude: draft.place?.latitude ?? null,
    longitude: draft.place?.longitude ?? null,
    poiId: draft.place?.poiId ?? null,
    priority: draft.priority,
    availability: draft.availability,
    status: draft.status,
    category: blankToNull(draft.category),
    url: blankToNull(draft.url),
    travelTimeMinutes: travel.ok ? travel.minutes : null,
    // 空串表示「不重复」；服务端的 PATCH 里 null 是「不修改」，所以这里给的是 '' 而不是 null，
    // 否则用户把重复改回「不重复」会静默失效（与地点清空是同一个坑，spec §4.1.4）
    rrule: draft.rrule.trim(),
  };
}

/** 从已有日程还原草稿，供编辑页预填（编辑与新建共用同一个页面）。 */
export function draftFromEvent(event: EventDetail): EventDraft {
  const zone = event.timezone || 'Asia/Shanghai';
  return {
    title: event.title,
    startTime: timeInZone(event.startAt, zone),
    endTime: timeInZone(event.endAt, zone),
    allDay: event.allDay,
    locationDetail: event.locationDetail ?? '',
    /**
     * 判断「有没有地点」必须用 `== null`（同时覆盖 null 与 undefined）：
     * Java 那边配了 `default-property-inclusion: non_null`，值为空时**字段整个消失**，
     * 客户端拿到的是 `undefined` 而不是 `null`。写成 `=== null` 会给一条没有任何地点的日程
     * 造出一个叫「已选地点」的假地点。
     */
    place:
      event.locationName == null && event.latitude == null
        ? null
        : {
            poiId: event.poiId ?? null,
            name: event.locationName ?? '已选地点',
            address: event.locationAddress ?? null,
            latitude: event.latitude ?? null,
            longitude: event.longitude ?? null,
          },
    description: event.description ?? '',
    url: event.url ?? '',
    category: event.category ?? '',
    // 已取消的日程不在编辑器的状态选项里，按「已确认」处理，避免出现选不中的分段控件
    priority: event.priority ?? 'NORMAL',
    availability: event.availability ?? 'BUSY',
    status: event.status === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED',
    /**
     * 同上：字段缺失时是 `undefined`，`String(undefined)` 会得到字符串 `"undefined"`，
     * 于是编辑页那一栏显示成「undefined」，而且保存时被 `parseTravelTime` 判为非法 ——
     * 用户改一个字都存不进去（2026-09-27 真机上实测到的就是这个）。
     */
    travelTimeMinutes: event.travelTimeMinutes == null ? '' : String(event.travelTimeMinutes),
    rrule: event.rrule ?? '',
    // 提醒由 PUT /reminders 单独维护（不在 event 行上），编辑页加载后另行拉取回填
    reminders: [],
  };
}

/** 该日程落在哪一天（用于编辑时定位日期）。 */
export function eventDateKey(event: EventDetail): string {
  return localDateKey(event.startAt, event.timezone || 'Asia/Shanghai');
}

/**
 * 编辑日程的请求体。
 *
 * 与新建的唯一差别是「清空」的语义：PATCH 里 null 表示**不修改**，
 * 空串才表示**清空**，所以这里把空的文本字段换成空串。
 */
export function buildUpdatePayload(dateKey: string, draft: EventDraft) {
  const base = buildCreatePayload(dateKey, draft);
  return {
    ...base,
    description: base.description ?? '',
    locationName: base.locationName ?? '',
    locationAddress: base.locationAddress ?? '',
    locationDetail: base.locationDetail ?? '',
    poiId: base.poiId ?? '',
    category: base.category ?? '',
    url: base.url ?? '',
  };
}

/** 把 ISO 时刻转成该时区的 HH:mm（编辑回填用；导出给组织日程编辑页共用）。 */
export function timeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 全天日程的结束时间落在次日，跨月跨年都要正确进位。 */
function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}
