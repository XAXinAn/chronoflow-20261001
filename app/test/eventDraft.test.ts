import { describe, expect, it } from 'vitest';

import {
  addMinutes,
  buildCreatePayload,
  emptyDraft,
  parseTime,
  toIso,
  validateDraft,
} from '../src/domain/eventDraft';

describe('新建日程草稿', () => {
  it('parseTime 接受 HH:mm 与 H:mm，拒绝越界或乱写', () => {
    expect(parseTime('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTime('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('')).toBeNull();
  });

  it('toIso 拼出带 +08:00 偏移的时刻', () => {
    expect(toIso('2026-10-05', '09:30')).toBe('2026-10-05T09:30:00+08:00');
    expect(toIso('2026-10-05', '9:05')).toBe('2026-10-05T09:05:00+08:00');
  });

  it('addMinutes 默认结束时间，跨午夜会回绕', () => {
    expect(addMinutes('09:00', 60)).toBe('10:00');
    expect(addMinutes('23:30', 60)).toBe('00:30');
    expect(addMinutes('乱写', 60)).toBe('10:00');
  });

  it('validateDraft 要求标题非空', () => {
    expect(validateDraft({ ...emptyDraft(), title: '  ' })).toEqual({
      ok: false,
      message: '请填写标题',
    });
    expect(validateDraft({ ...emptyDraft(), title: '开会' })).toEqual({ ok: true });
  });

  it('validateDraft 要求结束晚于开始', () => {
    expect(validateDraft({ ...emptyDraft(), title: '开会', startTime: '10:00', endTime: '10:00' })).toEqual({
      ok: false,
      message: '结束时间需晚于开始时间',
    });
    expect(validateDraft({ ...emptyDraft(), title: '开会', startTime: '09:00', endTime: '08:00' }).ok).toBe(
      false,
    );
  });

  it('validateDraft 对全天日程不校验时刻', () => {
    expect(
      validateDraft({ title: '年会', startTime: '乱写', endTime: '乱写', allDay: true }),
    ).toEqual({ ok: true });
  });

  it('buildCreatePayload 定时日程落在同一天', () => {
    expect(buildCreatePayload('2026-10-05', { ...emptyDraft(), title: ' 评审 ', startTime: '14:00', endTime: '15:30' }))
      .toEqual({
        title: '评审',
        startAt: '2026-10-05T14:00:00+08:00',
        endAt: '2026-10-05T15:30:00+08:00',
        allDay: false,
      });
  });

  it('buildCreatePayload 全天日程跨到次日 00:00', () => {
    // 后端约束 end_at > start_at，因此全天不能用同一个时刻
    expect(buildCreatePayload('2026-10-05', { ...emptyDraft(), title: '团建', allDay: true })).toEqual({
      title: '团建',
      startAt: '2026-10-05T00:00:00+08:00',
      endAt: '2026-10-06T00:00:00+08:00',
      allDay: true,
    });
  });

  it('buildCreatePayload 全天日程跨月正确进位', () => {
    expect(buildCreatePayload('2026-10-31', { ...emptyDraft(), title: '月末', allDay: true }).endAt).toBe(
      '2026-11-01T00:00:00+08:00',
    );
  });
});
