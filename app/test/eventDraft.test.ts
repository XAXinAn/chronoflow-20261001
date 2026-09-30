import { describe, expect, it } from 'vitest';

import {
  buildCreatePayload,
  buildUpdatePayload,
  draftFromEvent,
  emptyDraft,
  parseTravelTime,
  parseTime,
  toIso,
  validateDraft,
} from '../src/domain/eventDraft';
import type { EventDetail } from '../src/api/types';

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

  it('validateDraft 要求标题非空', () => {
    expect(validateDraft({ ...emptyDraft(), title: '  ' })).toEqual({
      ok: false,
      message: '请填写标题',
    });
    expect(validateDraft({ ...emptyDraft(), title: '开会' })).toEqual({ ok: true });
  });

  it('validateDraft 只校验一个时间，格式不对才报错', () => {
    expect(validateDraft({ ...emptyDraft(), title: '开会', time: '10:00' })).toEqual({ ok: true });
    expect(validateDraft({ ...emptyDraft(), title: '开会', time: '乱写' }).ok).toBe(false);
  });

  it('validateDraft 一律校验时刻（没有「全天」这个开关了）', () => {
    expect(validateDraft({ ...emptyDraft(), title: '年会', time: '乱写' }).ok).toBe(false);
  });

  it('buildCreatePayload 定时日程落在同一天', () => {
    expect(buildCreatePayload('2026-10-05', { ...emptyDraft(), title: ' 评审 ', time: '14:00' }))
      .toEqual({
        title: '评审',
        at: '2026-10-05T14:00:00+08:00',
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

  it('时间拨到 00:00 就是「就这一天」（日程只有一个时间）', () => {
    const payload = buildCreatePayload('2026-10-05', { ...emptyDraft(), title: '团建', time: '00:00' });
    expect(payload.at).toBe('2026-10-05T00:00:00+08:00');
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

/**
 * 解析服务端响应时，**空字段是「不存在」而不是 `null`**。
 *
 * Java 侧配了 `default-property-inclusion: non_null`：值为空时字段整个消失。
 * 曾经写成 `event.travelTimeMinutes === null ? '' : String(...)`，于是字段缺失时
 * 得到字符串 `"undefined"`，编辑页那一栏显示成 `undefined`，并且被 `parseTravelTime`
 * 判为非法 —— 用户改一个字都存不进去（2026-09-27 真机上实测到）。
 * 地点那几行同理会造出一个叫「已选地点」的假地点。
 */
describe('从服务端响应还原草稿（字段可能整个缺失）', () => {
  const sparse = {
    id: 1,
    calendarId: 1,
    title: 'aaaaa',
    at: '2026-09-27T01:00:00Z',
    timezone: 'Asia/Shanghai',
    rrule: null,
    status: 'CONFIRMED',
    availability: 'BUSY',
    priority: 'NORMAL',
    // description / locationName / latitude / url / category / travelTimeMinutes 全部缺失
  } as unknown as EventDetail;

  it('缺失的字段还原成空值，不会变成字符串 "undefined"', () => {
    const draft = draftFromEvent(sparse);
    expect(draft.travelTimeMinutes).toBe('');
    expect(draft.url).toBe('');
    expect(draft.category).toBe('');
    expect(draft.description).toBe('');
  });

  it('没有地点时不会造出「已选地点」', () => {
    expect(draftFromEvent(sparse).place).toBeNull();
  });

  it('这样还原出来的草稿可以正常保存（校验不会被 undefined 卡住）', () => {
    expect(validateDraft(draftFromEvent(sparse))).toEqual({ ok: true });
  });
});
