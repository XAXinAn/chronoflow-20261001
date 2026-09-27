import type { Priority } from '../api/types';
import type { Task } from '../api/types';
import { isValidDateKey } from './calendar';
import { parseTime, toIso } from './eventDraft';
import { localDateKey } from './agenda';

/**
 * 新建待办草稿。
 *
 * 待办与日程的关键差别：截止时间可以完全不存在（「待安排」清单）。
 * 因此这里用 hasDue 显式表达「没有截止时间」，而不是靠空串猜。
 */
export interface TaskDraft {
  title: string;
  description: string;
  priority: Priority;
  hasDue: boolean;
  dueDate: string;
  dueTime: string;
  allDay: boolean;
  /** 关联的日程（spec §4.1.6）。标题一并留着，编辑页不必再查一次 */
  eventId: number | null;
  eventTitle: string | null;
  /**
   * 重复规则（RRULE，spec §4.1.2）：待办也能重复，如「每周五交周报」。
   * 与日程一样存 RRULE 字符串本身，生成/解析都在 domain/recurrence.ts。
   */
  rrule: string;
  /** 本地提醒的提前量（分钟）；服务端也存一份（PUT /reminders），用于换设备后重排 */
  reminders: number[];
}

export const TASK_PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'LOW', label: '低' },
  { value: 'NORMAL', label: '普通' },
  { value: 'HIGH', label: '重要' },
  { value: 'URGENT', label: '紧急' },
];

export function emptyTaskDraft(todayKey: string): TaskDraft {
  return {
    title: '',
    description: '',
    priority: 'NORMAL',
    hasDue: false,
    dueDate: todayKey,
    dueTime: '09:00',
    allDay: false,
    eventId: null,
    eventTitle: null,
    rrule: '',
    reminders: [],
  };
}

export type TaskDraftValidation = { ok: true } | { ok: false; message: string };

export function validateTaskDraft(draft: TaskDraft): TaskDraftValidation {
  if (!draft.title.trim()) {
    return { ok: false, message: '请填写标题' };
  }
  if (!draft.hasDue) {
    return { ok: true };
  }
  if (!isValidDateKey(draft.dueDate)) {
    return { ok: false, message: '截止日期格式应为 YYYY-MM-DD' };
  }
  if (!draft.allDay && !parseTime(draft.dueTime)) {
    return { ok: false, message: '截止时间格式应为 HH:mm' };
  }
  return { ok: true };
}

export function buildCreateTaskPayload(draft: TaskDraft) {
  const description = draft.description.trim();
  return {
    title: draft.title.trim(),
    description: description ? description : null,
    // 无截止时间的待办归入「待安排」，dueAt 送 null
    dueAt: draft.hasDue ? toIso(draft.dueDate, draft.allDay ? '00:00' : draft.dueTime) : null,
    allDay: draft.hasDue ? draft.allDay : false,
    priority: draft.priority,
    eventId: draft.eventId,
    // 空串表示「不重复」：服务端把空白一律归一成 null，PATCH 里 null 才是「不修改」
    rrule: draft.rrule.trim(),
  };
}

const TASK_TIMEZONE = 'Asia/Shanghai';

/** 从已有待办还原草稿，供编辑页预填。 */
export function draftFromTask(task: Task, todayKey: string): TaskDraft {
  if (!task.dueAt) {
    return {
      title: task.title,
      description: task.description ?? '',
      priority: task.priority ?? 'NORMAL',
      hasDue: false,
      dueDate: todayKey,
      dueTime: '09:00',
      allDay: false,
      // 后端开了 non_null 序列化：为空时字段会整个消失，拿到的是 undefined 而不是 null。
      // 必须在这里归一到 null，否则界面上「是否已关联」的判断会被 undefined 带偏。
      eventId: task.eventId ?? null,
      eventTitle: task.eventTitle ?? null,
      rrule: task.rrule ?? '',
      // 提醒由 PUT /reminders 单独维护，编辑页加载后另行拉取回填
      reminders: [],
    };
  }
  return {
    title: task.title,
    description: task.description ?? '',
    priority: task.priority ?? 'NORMAL',
    hasDue: true,
    dueDate: localDateKey(task.dueAt, TASK_TIMEZONE),
    dueTime: timeInZone(task.dueAt),
    allDay: task.allDay,
    eventId: task.eventId ?? null,
    eventTitle: task.eventTitle ?? null,
    rrule: task.rrule ?? '',
    reminders: [],
  };
}

/** 编辑待办的请求体：清空截止时间要靠 clearDueAt 显式表达。 */
export function buildUpdateTaskPayload(draft: TaskDraft) {
  const base = buildCreateTaskPayload(draft);
  return {
    title: base.title,
    description: base.description,
    priority: base.priority,
    dueAt: base.dueAt,
    allDay: base.allDay,
    clearDueAt: !draft.hasDue,
    eventId: base.eventId,
    // 解绑必须显式表达：null 在 PATCH 里是「不修改」
    clearEvent: draft.eventId === null,
    rrule: base.rrule,
  };
}

function timeInZone(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TASK_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
