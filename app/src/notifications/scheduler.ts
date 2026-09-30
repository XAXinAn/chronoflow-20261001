import { formatEventWhen } from '../domain/agenda';
import {
  planOccurrenceReminders,
  reminderNotificationBody,
  type ReminderOccurrenceInput,
} from '../domain/reminderSchedule';
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
  /** 正文里的地点（可空）：通知里看不到日程卡片，「在哪」要写出来 */
  location?: string | null;
  /** 时间范围内的每一次出现（重复日程会有多次） */
  occurrences: ReminderOccurrenceInput[];
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
  /**
   * 与一批请求对齐：这批里的目标按新计划重排，没出现在这批里的目标全部取消。
   *
   * 用在「App 启动 / 回到前台」的重排：用户在别处删了提醒、或把日程挪出了窗口，
   * 本机那份排期必须跟着消失，否则会出现「日程早没了，通知还在响」。
   */
  reconcile: (requests: ReminderRequest[], now?: Date) => Promise<ReminderSyncResult>;
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
  const sync = async (request: ReminderRequest, now = new Date()): Promise<ReminderSyncResult> => {
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
      const planned = planOccurrenceReminders({
        occurrences: request.occurrences,
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
                  body: reminderNotificationBody({
                    when: formatEventWhen(reminder.atIso, reminder.timezone),
                    location: request.location ?? null,
                  }),
                  data: {
                    targetType: request.targetType,
                    targetId: request.targetId,
                    minutesBefore: reminder.minutesBefore,
                    // 点击通知后要跳到「那一次」而不是整条序列
                    occurrenceDate: reminder.occurrenceDate,
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
  };

  const reconcile = async (
    requests: ReminderRequest[],
    now = new Date(),
  ): Promise<ReminderSyncResult> => {
      const wanted = new Set(
        requests.map((request) => reminderTargetKey(request.targetType, request.targetId)),
      );
      const map = await store.read();
      // 先清掉「这批里没有」的目标：用户可能在别的设备上把提醒删了
      for (const key of Object.keys(map)) {
        if (wanted.has(key)) {
          continue;
        }
        try {
          await gateway.cancelAll(map[key] ?? []);
        } catch {
          // 取消失败不影响后面的重排；这条记录继续留着，下次还会再试一次
          continue;
        }
        delete map[key];
      }
      // 先把「被清掉的」落盘再排新的：sync 会自己读写同一份映射表，
      // 不先写回的话它会读到还没删干净的旧表，把刚取消掉的记录又写回去
      await store.write(map);

      let scheduled = 0;
      let permissionDenied = false;
      let failed = false;
      for (const request of requests) {
        const result = await sync(request, now);
        scheduled += result.scheduled;
        permissionDenied = permissionDenied || result.permissionDenied;
        failed = failed || result.failed;
      }
      return { scheduled, permissionDenied, failed };
  };

  const cancel = async (targetType: ReminderTargetType, targetId: number): Promise<void> => {
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
  };

  return { sync, reconcile, cancel };
}

/** 本机没有通知模块（Web 预览 / 缺原生模块的构建）时的降级：主流程照常，只是排不了提醒。 */
export function createNoopReminderScheduler(): ReminderScheduler {
  return {
    async sync() {
      return { scheduled: 0, permissionDenied: false, failed: true };
    },
    async reconcile() {
      return { scheduled: 0, permissionDenied: false, failed: true };
    },
    async cancel() {
      // 没有本机排期，也就没有要取消的东西
    },
  };
}
