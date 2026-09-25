import type { Priority } from '../api/types';
import { isValidDateKey } from './calendar';
import { parseTime, toIso } from './eventDraft';

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
  };
}
