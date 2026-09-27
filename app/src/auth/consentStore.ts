import { hasAcceptedPolicy, type ConsentRecord } from '../domain/consent';

/**
 * 隐私政策同意记录的本地存储（spec §12）。
 *
 * 放安全存储而不是普通存储：这份记录是「用户确实同意过」的凭据，
 * 在被清理前都是我们唯一的证明。Web 预览 / 安全存储不可用时降级为内存，
 * 只影响本次会话（不会误判成「已同意」）。
 */

const STORAGE_KEY = 'xa-todo.privacy-consent';

export interface ConsentStore {
  read: () => Promise<ConsentRecord | null>;
  write: (record: ConsentRecord) => Promise<void>;
  clear: () => Promise<void>;
}

export function createMemoryConsentStore(initial: ConsentRecord | null = null): ConsentStore {
  let current = initial;
  return {
    async read() {
      return current;
    },
    async write(record) {
      current = record;
    },
    async clear() {
      current = null;
    },
  };
}

export async function createSecureConsentStore(): Promise<ConsentStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    async read() {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(raw) as ConsentRecord;
      } catch {
        // 记录坏了就当没同意过——重新弹一次的成本远低于「漏弹」
        await SecureStore.deleteItemAsync(STORAGE_KEY);
        return null;
      }
    },
    async write(record) {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(record));
    },
    async clear() {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    },
  };
}

/**
 * 读一次「要不要弹首启隐私政策弹窗」。
 *
 * 安全存储不可用时返回 true（**要弹**）：宁可在 Web 预览里多弹一次，
 * 也不能因为存储异常就跳过征得同意——那是最典型的违规收集。
 */
export async function needsPrivacyConsent(
  store?: ConsentStore,
  currentVersion?: string,
): Promise<boolean> {
  try {
    const target = store ?? (await createSecureConsentStore());
    const record = await target.read();
    return currentVersion === undefined
      ? !hasAcceptedPolicy(record)
      : !hasAcceptedPolicy(record, currentVersion);
  } catch {
    return true;
  }
}
