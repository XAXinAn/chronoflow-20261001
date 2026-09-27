/**
 * 通知总开关（spec §4.5「用户在设置 - 通知中可按类型开关」）。
 *
 * 存本机而不是服务端：提醒是**本机通知**，与设备绑定；服务端那份 `reminder` 记录
 * 是「这条日程设了哪些提前量」，与「这台手机要不要响」是两件事 —— 换设备时
 * 新设备默认开启，符合用户预期（他在旧设备关掉的是旧设备）。
 *
 * 默认**开启**：日程类 App 的到点提醒是核心功能，默认关掉等于让人以为提醒坏了。
 */
const STORAGE_KEY = 'xa-todo.notification-prefs';

export interface NotificationPrefs {
  /** 到点提醒总开关（本地通知） */
  enabled: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { enabled: true };

export interface NotificationPrefsStore {
  read: () => Promise<NotificationPrefs>;
  write: (prefs: NotificationPrefs) => Promise<void>;
}

/** 解析存储里的原始串；坏数据一律回默认值（开启），不影响 App 启动。 */
export function parseNotificationPrefs(raw: string | null): NotificationPrefs {
  if (!raw) {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return { enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function createMemoryNotificationPrefsStore(
  initial: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS,
): NotificationPrefsStore {
  let current = { ...initial };
  return {
    async read() {
      return { ...current };
    },
    async write(prefs) {
      current = { ...prefs };
    },
  };
}

export async function createSecureNotificationPrefsStore(): Promise<NotificationPrefsStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    async read() {
      return parseNotificationPrefs(await SecureStore.getItemAsync(STORAGE_KEY));
    },
    async write(prefs) {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(prefs));
    },
  };
}
