import { describe, expect, it } from 'vitest';

import {
  addMinutes,
  buildCreatePayload,
  buildUpdatePayload,
  emptyDraft,
  parseTravelTime,
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
      validateDraft({ ...emptyDraft(), title: '年会', startTime: '乱写', endTime: '乱写', allDay: true }),
    ).toEqual({ ok: true });
  });

  it('buildCreatePayload 定时日程落在同一天', () => {
    expect(buildCreatePayload('2026-10-05', { ...emptyDraft(), title: ' 评审 ', startTime: '14:00', endTime: '15:30' }))
      .toEqual({
        title: '评审',
        startAt: '2026-10-05T14:00:00+08:00',
        endAt: '2026-10-05T15:30:00+08:00',
        allDay: false,
        description: null,
        locationName: null,
        locationAddress: null,
      locationDetail: null,
        latitude: null,
        longitude: null,
        poiId: null,
        priority: 'NORMAL',
        availability: 'BUSY',
        status: 'CONFIRMED',
        category: null,
        url: null,
        travelTimeMinutes: null,
        rrule: '',
      });
  });

  it('buildCreatePayload 全天日程跨到次日 00:00', () => {
    // 后端约束 end_at > start_at，因此全天不能用同一个时刻
    const payload = buildCreatePayload('2026-10-05', { ...emptyDraft(), title: '团建', allDay: true });
    expect(payload.startAt).toBe('2026-10-05T00:00:00+08:00');
    expect(payload.endAt).toBe('2026-10-06T00:00:00+08:00');
    expect(payload.allDay).toBe(true);
  });

  it('buildCreatePayload 全天日程跨月正确进位', () => {
    expect(buildCreatePayload('2026-10-31', { ...emptyDraft(), title: '月末', allDay: true }).endAt).toBe(
      '2026-11-01T00:00:00+08:00',
    );
  });

  it('结构化地点与扩展字段原样进载荷，空的文本字段送 null', () => {
    const payload = buildCreatePayload('2026-10-05', {
      ...emptyDraft(),
      title: '季度评审',
      description: ' 带上 OKR ',
      url: 'https://example.com/meet',
      category: ' 会议 ',
      priority: 'HIGH',
      availability: 'FREE',
      status: 'TENTATIVE',
      travelTimeMinutes: '30',
      place: {
        poiId: 'BJ-NAN',
        name: '北京南站',
        address: '北京市丰台区永外街',
        latitude: 39.8654,
        longitude: 116.3787,
      },
    });

    expect(payload.locationName).toBe('北京南站');
    expect(payload.locationAddress).toBe('北京市丰台区永外街');
    expect(payload.latitude).toBe(39.8654);
    expect(payload.longitude).toBe(116.3787);
    expect(payload.poiId).toBe('BJ-NAN');
    expect(payload.description).toBe('带上 OKR');
    expect(payload.category).toBe('会议');
    expect(payload.url).toBe('https://example.com/meet');
    expect(payload.priority).toBe('HIGH');
    expect(payload.availability).toBe('FREE');
    expect(payload.status).toBe('TENTATIVE');
    expect(payload.travelTimeMinutes).toBe(30);
  });

  it('出行时间只接受 0-1440 的整数分钟', () => {
    expect(parseTravelTime('')).toEqual({ ok: true, minutes: null });
    expect(parseTravelTime(' 45 ')).toEqual({ ok: true, minutes: 45 });
    expect(parseTravelTime('1440')).toEqual({ ok: true, minutes: 1440 });
    expect(parseTravelTime('1441').ok).toBe(false);
    expect(parseTravelTime('-5').ok).toBe(false);
    expect(parseTravelTime('半小时').ok).toBe(false);

    expect(validateDraft({ ...emptyDraft(), title: '开会', travelTimeMinutes: '很久' })).toEqual({
      ok: false,
      message: '出行时间需为 0-1440 的分钟数',
    });
  });

  it('链接必须是 http(s)，避免存进库后无法打开', () => {
    expect(validateDraft({ ...emptyDraft(), title: '开会', url: 'example.com' })).toEqual({
      ok: false,
      message: '链接需以 http:// 或 https:// 开头',
    });
    expect(validateDraft({ ...emptyDraft(), title: '开会', url: 'https://example.com' })).toEqual({
      ok: true,
    });
  });

  it('重复规则原样提交；“不重复”要提交空串而不是 null', () => {
    // PATCH 里 null 表示「不修改」，所以清空重复必须用空串表达——
    // 否则用户把重复改回「不重复」会静默失效（与地点清空同一个坑，spec §4.1.4）
    expect(buildCreatePayload('2026-09-28', emptyDraft()).rrule).toBe('');
    expect(
      buildCreatePayload('2026-09-28', { ...emptyDraft(), rrule: 'FREQ=WEEKLY;BYDAY=MO' }).rrule,
    ).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(
      buildUpdatePayload('2026-09-28', { ...emptyDraft(), rrule: '  FREQ=DAILY  ' }).rrule,
    ).toBe('FREQ=DAILY');
  });
});
