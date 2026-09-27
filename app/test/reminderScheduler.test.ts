import { describe, expect, it } from 'vitest';

import { createMemoryReminderIdStore, reminderTargetKey } from '../src/notifications/reminderStore';
import {
  createNoopReminderScheduler,
  createReminderScheduler,
  type NotificationGateway,
  type ReminderRequest,
  type ScheduledNotification,
} from '../src/notifications/scheduler';

/**
 * 本地提醒排期（spec §4.5：到点提醒走 App 本地通知）。
 *
 * 这一层盯的是**顺序与账本**，不是「通知长什么样」：
 * 改了时间必须先把旧通知撤掉再排新的（否则同一条日程会响两次）、
 * 删除日程必须把它的通知全部撤掉、拿不到权限时绝不能往账本里写假 id。
 */

function createFakeGateway(options: { allowed?: boolean } = {}) {
  const scheduled: ScheduledNotification[] = [];
  const cancelled: string[][] = [];
  let counter = 0;
  const gateway: NotificationGateway = {
    async ensurePermission() {
      return options.allowed ?? true;
    },
    async cancelAll(ids) {
      cancelled.push([...ids]);
    },
    async schedule(notification) {
      scheduled.push(notification);
      counter += 1;
      return `notif-${counter}`;
    },
  };
  return { gateway, scheduled, cancelled };
}

/** 上海时间 08:00，日程是当天 10:00 开始 */
const NOW = new Date('2026-09-28T00:00:00Z');

const request: ReminderRequest = {
  targetType: 'EVENT',
  targetId: 12,
  title: '周会',
  location: '会议室 A',
  occurrences: [
    {
      startAt: '2026-09-28T10:00:00+08:00',
      allDay: false,
      timezone: 'Asia/Shanghai',
      occurrenceDate: null,
    },
  ],
  minutesBefore: [15, 0],
};

describe('本地提醒排期', () => {
  it('按提前量排通知，并把本机 id 记进映射表', async () => {
    const { gateway, scheduled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    const result = await scheduler.sync(request, NOW);

    expect(result).toEqual({ scheduled: 2, permissionDenied: false, failed: false });
    // 升序：先 15 分钟前（01:45Z），再「到点」（02:00Z）
    expect(scheduled.map((item) => item.at.toISOString())).toEqual([
      '2026-09-28T01:45:00.000Z',
      '2026-09-28T02:00:00.000Z',
    ]);
    expect(scheduled[0]!.title).toBe('周会');
    expect(scheduled[0]!.data).toMatchObject({ targetType: 'EVENT', targetId: 12, minutesBefore: 15 });
    // 正文里要写清「几点、在哪」：通知中心里看不到日程卡片
    expect(scheduled[0]!.body).toBe('10:00 开始 · 会议室 A');
    expect(await store.read()).toEqual({ 'EVENT:12': ['notif-1', 'notif-2'] });
  });

  it('重复日程：一次出现一条通知，跨出现按时刻升序（通知中心的顺序与日历一致）', async () => {
    const { gateway, scheduled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    const result = await scheduler.sync(
      {
        ...request,
        occurrences: [
          { startAt: '2026-09-28T10:00:00+08:00', allDay: false, timezone: 'Asia/Shanghai', occurrenceDate: '2026-09-28' },
          { startAt: '2026-09-30T10:00:00+08:00', allDay: false, timezone: 'Asia/Shanghai', occurrenceDate: '2026-09-30' },
        ],
        minutesBefore: [0],
      },
      NOW,
    );

    expect(result.scheduled).toBe(2);
    expect(scheduled.map((item) => item.at.toISOString())).toEqual([
      '2026-09-28T02:00:00.000Z',
      '2026-09-30T02:00:00.000Z',
    ]);
    // 点击通知要跳到「那一次」，不是整条序列
    expect(scheduled[1]!.data).toMatchObject({ occurrenceDate: '2026-09-30' });
  });

  it('对齐（reconcile）：这批里没有的目标会被取消，出现在这批里的重排', async () => {
    const { gateway, cancelled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    await scheduler.sync(request, NOW);
    await scheduler.sync({ ...request, targetType: 'TASK', targetId: 7 }, NOW);
    expect(Object.keys(await store.read()).sort()).toEqual(['EVENT:12', 'TASK:7']);

    // 服务端只返回了 TASK:7（用户把日程的提醒删了 / 日程挪出了窗口）
    const result = await scheduler.reconcile([{ ...request, targetType: 'TASK', targetId: 7 }], NOW);

    expect(result.scheduled).toBe(2);
    // 第一次取消是 TASK:7 自己的重排，第二次是 EVENT:12 被清掉
    expect(cancelled).toContainEqual(['notif-1', 'notif-2']);
    expect(Object.keys(await store.read())).toEqual(['TASK:7']);
  });

  it('改了时间重排：先撤旧的再排新的，账本里不留旧 id', async () => {
    const { gateway, cancelled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    await scheduler.sync(request, NOW);
    // 用户把日程改到下午 15:00，提前量没变
    await scheduler.sync(
      {
        ...request,
        occurrences: [
          {
            startAt: '2026-09-28T15:00:00+08:00',
            allDay: false,
            timezone: 'Asia/Shanghai',
            occurrenceDate: null,
          },
        ],
      },
      NOW,
    );

    // 第二次是带着上一次的 id 去取消的 —— 少了这一步，中午还会按老时间响一次
    expect(cancelled[1]).toEqual(['notif-1', 'notif-2']);
    expect(await store.read()).toEqual({ 'EVENT:12': ['notif-3', 'notif-4'] });
  });

  it('清空提醒：撤掉旧的，账本里也不留空记录', async () => {
    const { gateway, cancelled, scheduled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    await scheduler.sync(request, NOW);
    const result = await scheduler.sync({ ...request, minutesBefore: [] }, NOW);

    expect(result.scheduled).toBe(0);
    expect(cancelled[1]).toEqual(['notif-1', 'notif-2']);
    expect(scheduled).toHaveLength(2);
    expect(await store.read()).toEqual({});
  });

  it('已经过去的时刻不排（也不去申请权限：根本不需要通知）', async () => {
    const { gateway, scheduled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    let permissionAsked = false;
    const scheduler = createReminderScheduler({
      gateway: {
        ...gateway,
        async ensurePermission() {
          permissionAsked = true;
          return true;
        },
      },
      store,
    });

    // 已经是当天 11:00（UTC 03:00）
    const result = await scheduler.sync(request, new Date('2026-09-28T03:00:00Z'));

    expect(result).toEqual({ scheduled: 0, permissionDenied: false, failed: false });
    expect(scheduled).toHaveLength(0);
    expect(permissionAsked).toBe(false);
    expect(await store.read()).toEqual({});
  });

  it('没有通知权限：如实返回，且不往账本里写假 id', async () => {
    const { gateway, scheduled } = createFakeGateway({ allowed: false });
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    const result = await scheduler.sync(request, NOW);

    expect(result).toEqual({ scheduled: 0, permissionDenied: true, failed: false });
    expect(scheduled).toHaveLength(0);
    // 写进去的话，下次重排会拿着这批并不存在的 id 去取消（无意义且掩盖问题）
    expect(await store.read()).toEqual({});
  });

  it('删除时撤掉这条日程的全部通知', async () => {
    const { gateway, cancelled } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    await scheduler.sync(request, NOW);
    await scheduler.cancel('EVENT', 12);

    expect(cancelled[1]).toEqual(['notif-1', 'notif-2']);
    expect(await store.read()).toEqual({});

    // 再删一次（或删一条从没排过提醒的日程）不该有任何动作
    await scheduler.cancel('EVENT', 12);
    expect(cancelled).toHaveLength(2);
  });

  it('日程与待办的 id 不撞车（映射表的键带类型前缀）', async () => {
    const { gateway } = createFakeGateway();
    const store = createMemoryReminderIdStore();
    const scheduler = createReminderScheduler({ gateway, store });

    await scheduler.sync(request, NOW);
    await scheduler.sync({ ...request, targetType: 'TASK' }, NOW);

    expect(Object.keys(await store.read()).sort()).toEqual(['EVENT:12', 'TASK:12']);
    expect(reminderTargetKey('EVENT', 12)).not.toBe(reminderTargetKey('TASK', 12));

    // 删日程不该把同名待办的提醒一起撤掉
    await scheduler.cancel('EVENT', 12);
    expect(Object.keys(await store.read())).toEqual(['TASK:12']);
  });

  it('通知模块不可用时降级：不抛异常，只是排不上', async () => {
    const scheduler = createNoopReminderScheduler();
    await expect(scheduler.sync(request, NOW)).resolves.toMatchObject({ scheduled: 0 });
    await expect(scheduler.cancel('EVENT', 12)).resolves.toBeUndefined();
  });
});
