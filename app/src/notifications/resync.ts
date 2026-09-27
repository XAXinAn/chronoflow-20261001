import type { ReminderScheduleEntry } from '../api/types';
import type { ReminderRequest, ReminderScheduler, ReminderSyncResult } from './scheduler';
import type { ReminderTargetType } from './reminderStore';

/** 重排窗口：与 `SCHEDULE_HORIZON_DAYS` 对齐（iOS 待触发通知有限，排太远没意义）。 */
export const RESYNC_WINDOW_DAYS = 30;

export interface ReminderScheduleSource {
  reminderSchedule: (start: string, end: string) => Promise<ReminderScheduleEntry[]>;
}

/**
 * 把服务端给的排期清单归并成「每个目标一条请求」。
 *
 * 服务端是按**每次出现**给的（重复日程会有多条），而本机排期是按目标记账的
 * （编辑 / 删除时要能一次撤掉这个目标的全部通知），所以这里要按目标把出现合并起来。
 * 同一条日程的不同出现如果提醒设置不同（服务端理论上不会，但数据结构允许），
 * 取并集 —— 宁可多提醒一次，也不要悄悄漏掉用户设过的那个提前量。
 */
export function groupScheduleEntries(entries: ReminderScheduleEntry[]): ReminderRequest[] {
  const grouped = new Map<string, ReminderRequest>();
  for (const entry of entries) {
    const key = `${entry.targetType}:${entry.targetId}`;
    const existing = grouped.get(key);
    const occurrence = {
      startAt: entry.startAt,
      allDay: entry.allDay,
      timezone: entry.timezone,
      occurrenceDate: entry.occurrenceDate ?? null,
    };
    if (!existing) {
      grouped.set(key, {
        targetType: entry.targetType as ReminderTargetType,
        targetId: entry.targetId,
        title: entry.title,
        location: entry.locationName ?? null,
        occurrences: [occurrence],
        minutesBefore: [...entry.minutesBefore],
      });
      continue;
    }
    existing.occurrences.push(occurrence);
    existing.minutesBefore = [...new Set([...existing.minutesBefore, ...entry.minutesBefore])].sort(
      (left, right) => left - right,
    );
  }
  return [...grouped.values()];
}

/**
 * 让本机排期与「未来 30 天该响什么」一致。
 *
 * 什么时候跑：冷启动、回到前台、以及每次保存 / 删除日程之后。
 * 只跑一次请求：重复日程的展开在服务端完成，客户端不做 RRULE 展开（两版展开规则
 * 一旦不一致，「某条重复日程在这台手机上不响」几乎无法排查）。
 *
 * `enabled=false`（用户在「我的 → 通知」关掉了）时不下发新排期，并把已排的全部取消。
 */
export async function resyncLocalReminders(options: {
  source: ReminderScheduleSource;
  scheduler: ReminderScheduler;
  /** 通知总开关（本机偏好） */
  enabled: boolean;
  now?: Date;
  windowDays?: number;
}): Promise<ReminderSyncResult> {
  const now = options.now ?? new Date();
  if (!options.enabled) {
    // 关掉通知 = 撤掉全部本机排期（不请求服务端：设置还在，只是本机不响）
    await options.scheduler.reconcile([], now);
    return { scheduled: 0, permissionDenied: false, failed: false };
  }
  const end = new Date(now.getTime() + (options.windowDays ?? RESYNC_WINDOW_DAYS) * 24 * 60 * 60 * 1000);
  const entries = await options.source.reminderSchedule(now.toISOString(), end.toISOString());
  return options.scheduler.reconcile(groupScheduleEntries(entries), now);
}
