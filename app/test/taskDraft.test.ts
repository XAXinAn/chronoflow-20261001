import { describe, expect, it } from 'vitest';

import { isValidDateKey } from '../src/domain/calendar';
import {
  buildCreateTaskPayload,
  buildUpdateTaskPayload,
  draftFromTask,
  emptyTaskDraft,
  validateTaskDraft,
} from '../src/domain/taskDraft';
import type { Task } from '../src/api/types';

/**
 * 待办的重复规则与提醒（spec §4.1.2）。
 *
 * 与日程同一套语义：**空串 = 不重复**（PATCH 里 null 是「不修改」），
 * 而提醒不走 task 行，编辑页要单独拉一次 `GET /reminders`。
 */
describe('待办的重复与提醒', () => {
  const task: Task = {
    id: 7,
    calendarId: 1,
    parentTaskId: null,
    eventId: null,
    eventTitle: null,
    title: '交周报',
    description: null,
    dueAt: '2026-10-09T10:00:00Z',
    status: 'TODO',
    completedAt: null,
    priority: 'NORMAL',
    rrule: 'FREQ=WEEKLY;BYDAY=FR',
    sortOrder: 0,
  };

  it('回填：服务端的 rrule 能还原到草稿，编辑一次不会把它抹掉', () => {
    const draft = draftFromTask(task, '2026-10-05');
    expect(draft.rrule).toBe('FREQ=WEEKLY;BYDAY=FR');
    // 提醒不在 task 行上，由编辑页另行拉取
    expect(draft.reminders).toEqual([]);
    expect(buildUpdateTaskPayload(draft).rrule).toBe('FREQ=WEEKLY;BYDAY=FR');
  });

  it('改回「不重复」提交的是空串（null 在 PATCH 里是「不修改」）', () => {
    const draft = { ...draftFromTask(task, '2026-10-05'), rrule: '' };
    expect(buildUpdateTaskPayload(draft).rrule).toBe('');
    expect(buildCreateTaskPayload({ ...draft, title: '交周报' }).rrule).toBe('');
  });

  it('没设过 rrule 的待办（字段缺失）按「不重复」处理', () => {
    const draft = draftFromTask({ ...task, rrule: undefined }, '2026-10-05');
    expect(draft.rrule).toBe('');
  });
});

describe('新建待办草稿', () => {
  it('默认不设截止时间，归入「待安排」', () => {
    const draft = emptyTaskDraft('2026-10-05');
    expect(draft.hasDue).toBe(false);
    expect(validateTaskDraft({ ...draft, title: '买牛奶' })).toEqual({ ok: true });
    expect(buildCreateTaskPayload({ ...draft, title: '买牛奶' }).dueAt).toBeNull();
  });

  it('设了截止时间就拼成带时区的时刻', () => {
    const draft = {
      ...emptyTaskDraft('2026-10-05'),
      title: '交周报',
      hasDue: true,
      dueDate: '2026-10-09',
      dueTime: '18:00',
    };
    expect(buildCreateTaskPayload(draft).dueAt).toBe('2026-10-09T18:00:00+08:00');
  });

  it('时间拨到 00:00 就是「就这一天」', () => {
    const draft = {
      ...emptyTaskDraft('2026-10-05'),
      title: '盘点',
      hasDue: true,
      dueDate: '2026-10-09',
      dueTime: '00:00',
    };
    expect(buildCreateTaskPayload(draft).dueAt).toBe('2026-10-09T00:00:00+08:00');
  });

  it('标题为空要拦住', () => {
    expect(validateTaskDraft({ ...emptyTaskDraft('2026-10-05'), title: '   ' })).toEqual({
      ok: false,
      message: '请填写标题',
    });
  });

  it('截止日期必须是真实存在的一天', () => {
    const base = { ...emptyTaskDraft('2026-10-05'), title: '交周报', hasDue: true };
    expect(validateTaskDraft({ ...base, dueDate: '2026-02-30' })).toEqual({
      ok: false,
      message: '截止日期格式应为 YYYY-MM-DD',
    });
    expect(validateTaskDraft({ ...base, dueDate: '2026-10-09' }).ok).toBe(true);
  });

  it('截止时间格式非法要拦住', () => {
    const base = {
      ...emptyTaskDraft('2026-10-05'),
      title: '交周报',
      hasDue: true,
      dueDate: '2026-10-09',
    };
    expect(validateTaskDraft({ ...base, dueTime: '25:00' })).toEqual({
      ok: false,
      message: '截止时间格式应为 HH:mm',
    });
  });

  it('isValidDateKey 拒绝形状正确但不存在的日期', () => {
    expect(isValidDateKey('2026-10-05')).toBe(true);
    expect(isValidDateKey('2024-02-29')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('2026-1-1')).toBe(false);
    expect(isValidDateKey('')).toBe(false);
  });
});
