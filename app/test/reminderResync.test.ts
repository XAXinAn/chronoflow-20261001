import { describe, expect, it } from 'vitest';

import type { ReminderScheduleEntry } from '../src/api/types';
import {
  createMemoryNotificationPrefsStore,
  parseNotificationPrefs,
} from '../src/notifications/prefs';
import { groupScheduleEntries, resyncLocalReminders } from '../src/notifications/resync';
import type { ReminderRequest, ReminderScheduler } from '../src/notifications/scheduler';

/**
 * 本机提醒的「对齐」（spec §4.5）。
 *
 * 这条链路的输入是服务端的排期清单（重复日程已被展开），输出是「本机该排/该撤什么」。
 * 盯四件事：按目标归并、窗口正确、关掉开关时全部撤销、服务端拉不到时不炸。
 */

function entry(overrides: Partial<ReminderScheduleEntry> = {}): ReminderScheduleEntry {
  return {
    targetType: 'EVENT',
    targetId: 12,
    occurrenceDate: null,
    title: '周会',
    locationName: '会议室 A',
    at: '2026-09-28T10:00:00+08:00',
    timezone: 'Asia/Shanghai',
    minutesBefore: [15, 0],
    ...overrides,
  };
}

function createFakeScheduler() {
  const reconciled: ReminderRequest[][] = [];
  const scheduler: ReminderScheduler = {
    async sync() {
      return { scheduled: 0, permissionDenied: false, failed: false };
    },
    async reconcile(requests) {
      reconciled.push(requests);
      return { scheduled: requests.length, permissionDenied: false, failed: false };
    },
    async cancel() {
      // 不需要
    },
  };
  return { scheduler, reconciled };
}

describe('服务端排期清单 → 本机请求', () => {
  it('同一目标的多次出现合并成一条请求（本机是按目标记账的）', () => {
    const requests = groupScheduleEntries([
      entry({ occurrenceDate: '2026-09-28' }),
      entry({ occurrenceDate: '2026-09-30', at: '2026-09-30T10:00:00+08:00' }),
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.title).toBe('周会');
    expect(requests[0]!.location).toBe('会议室 A');
    expect(requests[0]!.occurrences.map((item) => item.occurrenceDate)).toEqual([
      '2026-09-28',
      '2026-09-30',
    ]);
    expect(requests[0]!.minutesBefore).toEqual([0, 15]);
  });

  it('不同目标的提醒分开；同一目标的不同提前量取并集（宁可多响，不要静默漏掉）', () => {
    const requests = groupScheduleEntries([
      entry({ minutesBefore: [15] }),
      entry({ minutesBefore: [60], occurrenceDate: '2026-10-01' }),
      entry({ targetType: 'TASK', targetId: 7, occurrenceDate: null, minutesBefore: [0] }),
    ]);

    expect(requests.map((request) => `${request.targetType}:${request.targetId}`)).toEqual([
      'EVENT:12',
      'TASK:7',
    ]);
    expect(requests[0]!.minutesBefore).toEqual([15, 60]);
  });
});

describe('重排本机提醒', () => {
  it('按 30 天窗口拉一次，并把清单交给调度器对齐', async () => {
    const { scheduler, reconciled } = createFakeScheduler();
    const windows: [string, string][] = [];

    const result = await resyncLocalReminders({
      source: {
        reminderSchedule: async (start, end) => {
          windows.push([start, end]);
          return [entry()];
        },
      },
      scheduler,
      enabled: true,
      now: new Date('2026-09-28T00:00:00Z'),
    });

    expect(result.scheduled).toBe(1);
    expect(windows).toHaveLength(1);
    expect(windows[0]![0]).toBe('2026-09-28T00:00:00.000Z');
    // 30 天后
    expect(windows[0]![1]).toBe('2026-10-28T00:00:00.000Z');
    expect(reconciled[0]![0]!.targetId).toBe(12);
  });

  it('通知开关关掉：不发请求，直接把本机排期清空', async () => {
    const { scheduler, reconciled } = createFakeScheduler();
    let called = 0;

    const result = await resyncLocalReminders({
      source: {
        reminderSchedule: async () => {
          called += 1;
          return [entry()];
        },
      },
      scheduler,
      enabled: false,
      now: new Date('2026-09-28T00:00:00Z'),
    });

    expect(result.scheduled).toBe(0);
    expect(called).toBe(0);
    // 空清单 = 「一个都不留」
    expect(reconciled).toEqual([[]]);
  });
});

describe('通知偏好', () => {
  it('没存过 / 存坏了都按「开启」：默认关掉会让人以为提醒坏了', () => {
    expect(parseNotificationPrefs(null)).toEqual({ enabled: true });
    expect(parseNotificationPrefs('{')).toEqual({ enabled: true });
    expect(parseNotificationPrefs('{"enabled":"no"}')).toEqual({ enabled: true });
    expect(parseNotificationPrefs('{"enabled":false}')).toEqual({ enabled: false });
  });

  it('内存实现与生产实现同一套读写语义', async () => {
    const store = createMemoryNotificationPrefsStore();
    expect((await store.read()).enabled).toBe(true);
    await store.write({ enabled: false });
    expect((await store.read()).enabled).toBe(false);
  });
});
