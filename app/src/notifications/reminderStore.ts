/**
 * 「本地通知 id ↔ 业务对象」的映射（spec §4.5）。
 *
 * 一个日程可以排多条提醒（提前一天 + 提前十分钟），编辑或删除时要能**精确取消**它们；
 * 而 `expo-notifications` 只认它自己发回来的那串 id。所以这份映射是必须的：
 * 只按业务对象重排、却不记得旧 id，旧通知会留在系统里继续响，用户看到的
 * 就是「日程已经改到下午了，中午还是弹了一次」。
 *
 * 存安全存储，与主题偏好、隐私同意同一套写法（不再多引一个依赖）；
 * 内容很小（每个目标一行 id 数组），不会有容量问题。
 */

const STORAGE_KEY = 'chronoflow.reminder-notifications';

export type ReminderTargetType = 'EVENT' | 'TASK';

/** 映射表的键：`EVENT:12`。带类型前缀，避免日程与待办的自增 id 撞车。 */
export function reminderTargetKey(targetType: ReminderTargetType, targetId: number): string {
  return `${targetType}:${targetId}`;
}

export interface ReminderIdStore {
  read: () => Promise<Record<string, string[]>>;
  write: (map: Record<string, string[]>) => Promise<void>;
}

/** 内存实现：单测与「存储不可用」的降级路径用（只影响本次会话的取消能力）。 */
export function createMemoryReminderIdStore(
  initial: Record<string, string[]> = {},
): ReminderIdStore {
  let current = { ...initial };
  return {
    async read() {
      return { ...current };
    },
    async write(map) {
      current = { ...map };
    },
  };
}

export async function createSecureReminderIdStore(): Promise<ReminderIdStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    async read() {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!raw) {
        return {};
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // 只收「字符串数组」形态。坏数据直接丢：宁可能漏取消一条通知，
        // 也不要让一个解析异常把「保存日程」整条流程带崩。
        const result: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
            result[key] = value as string[];
          }
        }
        return result;
      } catch {
        return {};
      }
    },
    async write(map) {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(map));
    },
  };
}
