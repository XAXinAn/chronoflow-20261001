import type { Endpoints } from '../api/endpoints';
import { normalizeReminders, sameReminderSet } from '../domain/reminderSchedule';
import type { ReminderScheduler, ReminderSyncResult } from './scheduler';
import { resyncLocalReminders } from './resync';

/**
 * 保存提醒设置（总体覆盖，只在真的改过时才写服务端）。
 *
 * 抽出来是因为日程与待办两处都要做同一件事：`PUT /reminders` 是整体覆盖，
 * 没改也发一遍虽然结果一样，但会给服务端多一次无谓的删除 + 插入。
 */
export async function persistReminderSettings(options: {
  api: Endpoints;
  targetType: 'EVENT' | 'TASK';
  targetId: number;
  minutes: number[];
  initialMinutes: number[];
}): Promise<void> {
  if (sameReminderSet(options.minutes, options.initialMinutes)) {
    return;
  }
  await options.api.setReminders({
    targetType: options.targetType,
    targetId: options.targetId,
    reminders: normalizeReminders(options.minutes).map((minutesBefore) => ({ minutesBefore })),
  });
}

/**
 * 让本机排期跟上服务端（冷启动 / 回到前台 / 任何一次保存或删除之后）。
 *
 * 统一走「拉一次未来排期 + 对齐」而不是「本地算出这次改了什么」：删除、跨设备改动、
 * 换个窗口看今天的范围……本地推断总有漏掉的路径，而服务的清单是唯一的真值。
 * 失败不抛给调用方 —— 排不上提醒不该让「日程已保存」这件事看起来失败了。
 */
export async function refreshLocalReminders(options: {
  api: Endpoints;
  scheduler: ReminderScheduler;
  enabled: boolean;
  now?: Date;
}): Promise<ReminderSyncResult> {
  try {
    return await resyncLocalReminders({
      source: options.api,
      scheduler: options.scheduler,
      enabled: options.enabled,
      now: options.now,
    });
  } catch {
    return { scheduled: 0, permissionDenied: false, failed: true };
  }
}
