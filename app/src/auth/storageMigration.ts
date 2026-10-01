/**
 * 改名遗留：把旧前缀的本地存储键一次性搬到新前缀。
 *
 * <p>2026-10-01 项目从 `xa-todo` 改名为 `chronoflow`，本地存储键也跟着改了名
 * （`xa-todo.session` → `chronoflow.session` 等）。键名一改，老包升级上来的用户
 * **读不到旧值**，表现就是：莫名其妙要重新登录、重新同意隐私政策、通知偏好与
 * 组织账号列表清空。这里在启动最早期（读任何存储之前）把旧值搬过来。
 *
 * <p>搬运规则：**新键已有值就不动**（用户可能已经在用新版本存过东西了），
 * 搬完把旧键删掉——两套键长期并存，迟早会有人改了一个、读的是另一个。
 */

/** 只用到这三个方法，所以抽个小接口出来，测试里可以用内存实现顶上。 */
export interface StringKeyStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export const LEGACY_KEY_PREFIX = 'xa-todo.';
export const CURRENT_KEY_PREFIX = 'chronoflow.';

/**
 * 曾经用过的、带旧前缀的键（去掉前缀后的部分）。
 *
 * <p>**这个列表只增不减**：以后再加存储键，不需要动这里；但只要历史上用过旧名字，
 * 就得留在这里，否则那批用户的旧值永远搬不过来。
 */
export const LEGACY_KEY_SUFFIXES = [
  'session',
  'device-id',
  'privacy-consent',
  'org-accounts',
  'notification-prefs',
  'reminder-notifications',
  'scheme',
];

/** 返回真正搬了几条（便于启动日志里对一下）。 */
export async function migrateLegacyKeys(store: StringKeyStore): Promise<number> {
  let moved = 0;
  for (const suffix of LEGACY_KEY_SUFFIXES) {
    const legacyKey = `${LEGACY_KEY_PREFIX}${suffix}`;
    const currentKey = `${CURRENT_KEY_PREFIX}${suffix}`;
    const current = await store.getItemAsync(currentKey);
    if (current !== null) {
      continue;
    }
    const legacy = await store.getItemAsync(legacyKey);
    if (legacy === null) {
      continue;
    }
    await store.setItemAsync(currentKey, legacy);
    await store.deleteItemAsync(legacyKey);
    moved += 1;
  }
  return moved;
}

/**
 * 启动时调用一次。安全存储不可用（Web 预览 / 无原生模块）时静默跳过——
 * 那种环境本来就没有旧数据要搬。
 */
export async function migrateLegacyStorage(): Promise<number> {
  try {
    const SecureStore = await import('expo-secure-store');
    return await migrateLegacyKeys({
      getItemAsync: (key) => SecureStore.getItemAsync(key),
      setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
      deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
    });
  } catch {
    return 0;
  }
}
