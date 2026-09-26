import { describe, expect, it } from 'vitest';

import type { EventOccurrence, Task } from '../src/api/types';
import {
  formatDayLabel,
  formatTimeRange,
  groupByDay,
  localDateKey,
  sortTasks,
} from '../src/domain/agenda';

describe('日程领域逻辑', () => {
  it('localDateKey 按指定时区换算日期', () => {
    // 北京时间 10-05 09:00，同一时刻在 UTC 仍是 10-05 01:00
    expect(localDateKey('2026-10-05T01:00:00Z', 'Asia/Shanghai')).toBe('2026-10-05');
    // 北京时间 10-05 00:30（UTC 10-04 16:30）——按 UTC 会算成前一天
    expect(localDateKey('2026-10-04T16:30:00Z', 'Asia/Shanghai')).toBe('2026-10-05');
    expect(localDateKey('2026-10-04T16:30:00Z', 'UTC')).toBe('2026-10-04');
  });

  it('groupByDay 按日期分组且组内按时间升序', () => {
    const items = [
      { id: 'b', at: '2026-10-05T03:00:00Z' },
      { id: 'a', at: '2026-10-05T01:00:00Z' },
      { id: 'c', at: '2026-10-06T02:00:00Z' },
    ];
    const sections = groupByDay(items, (item) => item.at, 'Asia/Shanghai');

    expect(sections.map((section) => section.date)).toEqual(['2026-10-05', '2026-10-06']);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(['c']);
  });

  it('formatDayLabel 输出相对日期', () => {
    expect(formatDayLabel('2026-10-05', '2026-10-05')).toBe('今天');
    expect(formatDayLabel('2026-10-06', '2026-10-05')).toBe('明天');
    expect(formatDayLabel('2026-10-04', '2026-10-05')).toBe('昨天');
    // 2026-10-09 是周五，距 10-05 四天 → 展示周几
    expect(formatDayLabel('2026-10-09', '2026-10-05')).toBe('周五');
    expect(formatDayLabel('2026-10-20', '2026-10-05')).toBe('10 月 20 日');
  });

  it('formatTimeRange 全天不显示具体时刻', () => {
    expect(formatTimeRange('2026-10-05T01:00:00Z', '2026-10-05T02:00:00Z', true, 'Asia/Shanghai')).toBe('全天');
    expect(
      formatTimeRange('2026-10-05T01:00:00Z', '2026-10-05T02:00:00Z', false, 'Asia/Shanghai'),
    ).toBe('09:00 – 10:00');
  });

  it('sortTasks 未完成在前、按截止时间、无时间排最后', () => {
    const base = {
      calendarId: 1,
      parentTaskId: null,
      eventId: null,
      eventTitle: null,
      description: null,
      allDay: false,
      completedAt: null,
      sortOrder: 0,
    };
    const tasks: Task[] = [
      { ...base, id: 1, title: '无时间', dueAt: null, status: 'TODO', priority: 'HIGH' },
      { ...base, id: 2, title: '已完成', dueAt: '2026-10-01T00:00:00Z', status: 'DONE', priority: 'NORMAL' },
      { ...base, id: 3, title: '较晚', dueAt: '2026-10-09T00:00:00Z', status: 'TODO', priority: 'LOW' },
      { ...base, id: 4, title: '较早', dueAt: '2026-10-05T00:00:00Z', status: 'TODO', priority: 'NORMAL' },
    ];

    expect(sortTasks(tasks).map((task) => task.id)).toEqual([4, 3, 1, 2]);
  });

  it('groupByDay 对重复日程的多次出现分别归组', () => {
    const occurrences: EventOccurrence[] = [
      {
        eventId: 1,
        calendarId: 1,
        title: '站会',
        locationName: null,
        locationAddress: null,
        startAt: '2026-10-05T01:00:00Z',
        endAt: '2026-10-05T01:30:00Z',
        allDay: false,
        timezone: 'Asia/Shanghai',
        recurring: true,
        occurrenceDate: '2026-10-05',
        modified: false,
      },
      {
        eventId: 1,
        calendarId: 1,
        title: '站会',
        locationName: null,
        locationAddress: null,
        startAt: '2026-10-07T01:00:00Z',
        endAt: '2026-10-07T01:30:00Z',
        allDay: false,
        timezone: 'Asia/Shanghai',
        recurring: true,
        occurrenceDate: '2026-10-07',
        modified: false,
      },
    ];

    const sections = groupByDay(occurrences, (item) => item.startAt, 'Asia/Shanghai');
    expect(sections).toHaveLength(2);
    expect(sections[0]?.items[0]?.occurrenceDate).toBe('2026-10-05');
  });
});
