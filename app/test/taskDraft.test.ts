import { describe, expect, it } from 'vitest';

import { isValidDateKey } from '../src/domain/calendar';
import { buildCreateTaskPayload, emptyTaskDraft, validateTaskDraft } from '../src/domain/taskDraft';

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
    expect(buildCreateTaskPayload(draft).allDay).toBe(false);
  });

  it('全天待办落在当天 00:00', () => {
    const draft = {
      ...emptyTaskDraft('2026-10-05'),
      title: '盘点',
      hasDue: true,
      dueDate: '2026-10-09',
      allDay: true,
    };
    expect(buildCreateTaskPayload(draft).dueAt).toBe('2026-10-09T00:00:00+08:00');
    expect(buildCreateTaskPayload(draft).allDay).toBe(true);
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

  it('截止时间格式非法要拦住（全天时不校验时刻）', () => {
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
    expect(validateTaskDraft({ ...base, dueTime: '乱写', allDay: true })).toEqual({ ok: true });
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
