import { describe, expect, it } from 'vitest';

import {
  MAX_SCHEDULED_REMINDERS,
  MAX_CUSTOM_MINUTES,
  describeReminders,
  formatMinutesBefore,
  normalizeReminders,
  planOccurrenceReminders,
  parseCustomMinutes,
  planReminders,
  reminderBase,
  reminderNotificationBody,
  sameReminderSet,
  toggleReminder,
  zonedTimeToUtc,
  zoneOffsetMinutes,
} from '../src/domain/reminderSchedule';

/**
 * 本地提醒排期（spec §4.5：日程/待办的到点提醒走本地通知）。
 *
 * 盯三件事：过去的时刻不排、全天日程基准算对、超过上限要截断（iOS 待触发通知上限 64）。
 */
describe('提醒排期', () => {
  it('时区偏移换算（东八区 +480 分钟）', () => {
    expect(zoneOffsetMinutes(new Date('2026-09-28T04:00:00Z'), 'Asia/Shanghai')).toBe(480);
    expect(zoneOffsetMinutes(new Date('2026-09-28T04:00:00Z'), 'UTC')).toBe(0);
  });

  it('某天某点的当地时间能换算成绝对时刻', () => {
    // 上海 2026-09-28 09:00 = UTC 01:00
    expect(zonedTimeToUtc('2026-09-28', 9, 'Asia/Shanghai').toISOString())
      .toBe('2026-09-28T01:00:00.000Z');
  });

  it('全天日程的基准是当地 09:00（不是 00:00）', () => {
    const base = reminderBase({ startAt: '2026-09-28T00:00:00+08:00', allDay: true, timezone: 'Asia/Shanghai' });
    expect(base.toISOString()).toBe('2026-09-28T01:00:00.000Z');
  });

  it('普通日程的基准就是开始时刻', () => {
    const base = reminderBase({ startAt: '2026-09-28T14:30:00+08:00', allDay: false, timezone: 'Asia/Shanghai' });
    expect(base.toISOString()).toBe('2026-09-28T06:30:00.000Z');
  });

  it('提前量换算成绝对时刻，并按时间升序', () => {
    const planned = planReminders({
      startAt: '2026-09-28T14:30:00+08:00',
      allDay: false,
      timezone: 'Asia/Shanghai',
      minutesBefore: [60, 0, 15],
      now: new Date('2026-09-28T00:00:00Z'),
    });
    expect(planned.map((item) => item.minutesBefore)).toEqual([60, 15, 0]);
    expect(planned[0]!.at.toISOString()).toBe('2026-09-28T05:30:00.000Z');
    expect(planned[2]!.at.toISOString()).toBe('2026-09-28T06:30:00.000Z');
  });

  it('已经过去的时刻不排（否则保存后立刻弹一堆过期提醒）', () => {
    const planned = planReminders({
      startAt: '2026-09-28T14:30:00+08:00',
      allDay: false,
      timezone: 'Asia/Shanghai',
      minutesBefore: [1440, 60, 0],
      // 已经是当天 14:00（UTC 06:00）：提前一天（前日 06:30）与提前一小时（05:30）都过去了，
      // 只剩「到点」这一条
      now: new Date('2026-09-28T06:00:00Z'),
    });
    expect(planned.map((item) => item.minutesBefore)).toEqual([0]);
  });

  it('重复的提前量只排一次', () => {
    const planned = planReminders({
      startAt: '2026-09-28T14:30:00+08:00',
      allDay: false,
      timezone: 'Asia/Shanghai',
      minutesBefore: [15, 15, 15],
      now: new Date('2026-09-28T00:00:00Z'),
    });
    expect(planned).toHaveLength(1);
  });

  it('超过上限要截断（iOS 待触发通知上限 64，这里留余量到 60）', () => {
    const many = Array.from({ length: 200 }, (_, index) => index + 1);
    const planned = planReminders({
      startAt: '2026-10-28T14:30:00+08:00',
      allDay: false,
      timezone: 'Asia/Shanghai',
      minutesBefore: many,
      now: new Date('2026-09-28T00:00:00Z'),
    });
    expect(planned).toHaveLength(MAX_SCHEDULED_REMINDERS);
  });

  it('提前量的中文说法', () => {
    expect(formatMinutesBefore(0)).toBe('到点');
    expect(formatMinutesBefore(15)).toBe('提前 15 分钟');
    expect(formatMinutesBefore(60)).toBe('提前 1 小时');
    expect(formatMinutesBefore(1440)).toBe('提前 1 天');
  });
});

/**
 * 提醒的界面值（编辑页那一行 + 提醒页的多选）。
 *
 * 盯三件事：**提交前归一**（`PUT /reminders` 是整体覆盖，顺序不同不该被当成改过）、
 * **勾选可来回**、**自定义输入不静默改值**（用户输了 0 必须报错，而不是悄悄变成「到点」）。
 */
describe('提醒的界面值', () => {
  it('归一：去重 + 升序', () => {
    expect(normalizeReminders([60, 0, 15, 60])).toEqual([0, 15, 60]);
    expect(normalizeReminders([])).toEqual([]);
  });

  it('勾选与取消', () => {
    expect(toggleReminder([], 15)).toEqual([15]);
    expect(toggleReminder([15], 15)).toEqual([]);
    // 后加的更早，也要排到前面
    expect(toggleReminder([1440], 5)).toEqual([5, 1440]);
  });

  it('等价判断不看顺序与重复（否则「没改过」也会多发一次 PUT）', () => {
    expect(sameReminderSet([15, 0], [0, 15])).toBe(true);
    expect(sameReminderSet([15, 15], [15])).toBe(true);
    expect(sameReminderSet([15], [30])).toBe(false);
    expect(sameReminderSet([], [0])).toBe(false);
  });

  it('列表上的一句话', () => {
    expect(describeReminders([])).toBe('不提醒');
    expect(describeReminders([0])).toBe('到点');
    expect(describeReminders([1440, 15])).toBe('提前 15 分钟、提前 1 天');
  });

  it('自定义：只收 1-10080 的整数分钟', () => {
    expect(parseCustomMinutes('45')).toEqual({ ok: true, minutes: 45 });
    expect(parseCustomMinutes(' 90 ')).toEqual({ ok: true, minutes: 90 });
    expect(parseCustomMinutes(String(MAX_CUSTOM_MINUTES))).toEqual({ ok: true, minutes: MAX_CUSTOM_MINUTES });
    expect(parseCustomMinutes('')).toMatchObject({ ok: false });
    expect(parseCustomMinutes('5 分钟')).toMatchObject({ ok: false });
    expect(parseCustomMinutes('-5')).toMatchObject({ ok: false });
    // 0 是预置项「到点」，自定义里输 0 必须报错而不是静默当成 0
    expect(parseCustomMinutes('0')).toMatchObject({ ok: false });
    expect(parseCustomMinutes(String(MAX_CUSTOM_MINUTES + 1))).toMatchObject({ ok: false });
  });

  it('通知正文说清「几点、在哪」（通知里看不到日程卡片）', () => {
    expect(reminderNotificationBody({ allDay: false, startTime: '10:00', location: '会议室 A' }))
      .toBe('10:00 开始 · 会议室 A');
    expect(reminderNotificationBody({ allDay: false, startTime: '10:00', location: null }))
      .toBe('10:00 开始');
    // 全天日程没有时刻可写，写「全天」而不是 00:00
    expect(reminderNotificationBody({ allDay: true, startTime: '09:00' })).toBe('全天');
  });

  it('重复日程的多次出现：跨出现按时刻升序，并按总数截断', () => {
    const planned = planOccurrenceReminders({
      occurrences: [
        { startAt: '2026-10-07T10:00:00+08:00', allDay: false, timezone: 'Asia/Shanghai', occurrenceDate: '2026-10-07' },
        { startAt: '2026-10-05T10:00:00+08:00', allDay: false, timezone: 'Asia/Shanghai', occurrenceDate: '2026-10-05' },
      ],
      minutesBefore: [60],
      now: new Date('2026-10-01T00:00:00Z'),
    });

    expect(planned.map((item) => item.occurrenceDate)).toEqual(['2026-10-05', '2026-10-07']);
    expect(planned.map((item) => item.at.toISOString())).toEqual([
      '2026-10-05T01:00:00.000Z',
      '2026-10-07T01:00:00.000Z',
    ]);
  });

  it('已经过去的那些出现不排（补排历史提醒只会骚扰用户）', () => {
    const planned = planOccurrenceReminders({
      occurrences: [
        { startAt: '2026-09-28T10:00:00+08:00', allDay: false, timezone: 'Asia/Shanghai', occurrenceDate: '2026-09-28' },
        { startAt: '2026-10-05T10:00:00+08:00', allDay: false, timezone: 'Asia/Shanghai', occurrenceDate: '2026-10-05' },
      ],
      minutesBefore: [0],
      now: new Date('2026-10-01T00:00:00Z'),
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]!.occurrenceDate).toBe('2026-10-05');
  });
});
