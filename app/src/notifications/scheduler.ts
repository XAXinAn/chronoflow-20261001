import { planReminders } from '../domain/reminderSchedule';
import { reminderTargetKey, type ReminderIdStore, type ReminderTargetType } from './reminderStore';

/** 交给原生层的一条本地通知。 */
export interface ScheduledNotification {
  at: Date;
  title: string;
  body: string;
  /** 点击通知时要跳到哪里（统一路由用，spec §4.5） */
  data: Record<string, unknown>;
}

/**
 * 原生通知能力的抽象。
 *
 * 抽出来是为了让「取消旧的 → 排新的 → 记下新 id」这套顺序能在 node 里单测，
 * 而不是只能靠真机点一遍才发现「改了时间还是响两次」。
 */
export interface NotificationGateway {
  /** 申请通知权限；false 表示用户拒绝或系统不再询问 */
  ensurePermission: () => Promise<boolean>;
  cancelAll: (ids: string[]) => Promise<void>;
  /** 排一条本地通知，返回本机标识 */
  schedule: (notification: ScheduledNotification) => Promise<string>;
}

export interface ReminderRequest {
  targetType: ReminderTargetType;
  targetId: number;
  /** 通知标题（就是日程标题：通知中心里一眼看到「哪件事」） */
  title: string;
  /** 通知正文（几点开始、在哪） */
  body: string;
  /** 日程开始时刻（ISO 8601 带时区） */
  startAt: string;
  allDay: boolean;
  timezone: string;
  minutesBefore: number[];
}

export interface ReminderSyncResult {
  /** 实际排上了几条 */
  scheduled: number;
  /** 用户没给通知权限：调用方该提示一句，而不是当作成功 */
  permissionDenied: boolean;
  /** 排期过程中出过错（已尽力，不抛给调用方 —— 日程保存不该被本地通知拖垮） */
  failed: boolean;
}

export interface ReminderScheduler {
  /** 让本机排期与「这条日程当前的提醒设置」一致 */
  sync: (request: ReminderRequest, now?: Date) => Promise<ReminderSyncResult>;
  /** 日程/待办被删除时调用 */
  cancel: (targetType: ReminderTargetType, targetId: number) => Promise<void>;
}

/**
 * 本地提醒排期。
 *
 * 顺序很关键：**先取消旧的全部，再排新的**。反过来的话，改了时间的日程
 * 会同时留着「按旧时间响」和「按新时间响」两条通知。
 */
export function createReminderScheduler({
  gateway,
  store,
}: {
  gateway: NotificationGateway;
  store: ReminderIdStore;
}): ReminderScheduler {
  return {
    async sync(request, now = new Date()) {
      const key = reminderTargetKey(request.targetType, request.targetId);
      const map = await store.read();

      // 旧的一定先撤：后面不论排不排得上，用户都不该再收到按老设置响的提醒
      try {
        await gateway.cancelAll(map[key] ?? []);
      } catch {
        // 取消失败不影响重排（最差是旧通知多响一次）
      }
      delete map[key];

      const result: ReminderSyncResult = { scheduled: 0, permissionDenied: false, failed: false };
      const planned = planReminders({
        startAt: request.startAt,
        allDay: request.allDay,
        timezone: request.timezone,
        minutesBefore: request.minutesBefore,
        now,
      });

      const ids: string[] = [];
      if (planned.length > 0) {
        let allowed = false;
        try {
          allowed = await gateway.ensurePermission();
        } catch {
          result.failed = true;
        }
        if (!allowed) {
          // 没有权限时不去写映射表：不然下次进来会拿着一批并不存在的 id 去取消
          result.permissionDenied = true;
        } else {
          for (const reminder of planned) {
            try {
              ids.push(
                await gateway.schedule({
                  at: reminder.at,
                  title: request.title,
                  body: request.body,
                  data: {
                    targetType: request.targetType,
                    targetId: request.targetId,
                    minutesBefore: reminder.minutesBefore,
                  },
                }),
              );
            } catch {
              result.failed = true;
            }
          }
        }
      }

      if (ids.length > 0) {
        map[key] = ids;
      }
      try {
        await store.write(map);
      } catch {
        result.failed = true;
      }
      result.scheduled = ids.length;
      return result;
    },

    async cancel(targetType, targetId) {
      const key = reminderTargetKey(targetType, targetId);
      const map = await store.read();
      const ids = map[key];
      if (!ids || ids.length === 0) {
        return;
      }
      // 先真的取消掉，再抹掉记录：反过来的话取消失败就再也找不到这批 id 了
      await gateway.cancelAll(ids);
      delete map[key];
      await store.write(map);
    },
  };
}

/** 本机没有通知模块（Web 预览 / 缺原生模块的构建）时的降级：主流程照常，只是排不了提醒。 */
export function createNoopReminderScheduler(): ReminderScheduler {
  return {
    async sync() {
      return { scheduled: 0, permissionDenied: false, failed: true };
    },
    async cancel() {
      // 没有本机排期，也就没有要取消的东西
    },
  };
}
