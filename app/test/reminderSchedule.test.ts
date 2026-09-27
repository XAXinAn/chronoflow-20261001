import { describe, expect, it } from 'vitest';

import {
  MAX_SCHEDULED_REMINDERS,
  formatMinutesBefore,
  planReminders,
  reminderBase,
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
