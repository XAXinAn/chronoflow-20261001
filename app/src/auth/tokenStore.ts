import type { IdentityType } from '../api/types';

/**
 * 持久化的会话。`expiresAt` 是签发时刻推算出的绝对过期时间，
 * 用于判断是否需要**提前**静默刷新（spec §3.7.2）。
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: number;
  identityId: number;
  identityType: IdentityType;
  orgId: number | null;
  nickname: string | null;
}

export interface TokenStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

const STORAGE_KEY = 'chronoflow.session';
const DEVICE_KEY = 'chronoflow.device-id';

export function createMemoryTokenStore(initial: StoredSession | null = null): TokenStore {
  let current = initial;
  return {
    async read() {
      return current;
    },
    async write(session) {
      current = session;
    },
    async clear() {
      current = null;
    },
  };
}

/**
 * 生产实现：刷新令牌存放于安全存储（iOS Keychain / Android Keystore），
 * 不写入普通存储或日志（spec §3.7.2）。
 *
 * 用动态 import 是为了让本模块在 node 环境下也能被单测直接加载。
 */
export async function createSecureTokenStore(): Promise<TokenStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    async read() {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(raw) as StoredSession;
      } catch {
        await SecureStore.deleteItemAsync(STORAGE_KEY);
        return null;
      }
    },
    async write(session) {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
    },
    async clear() {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    },
  };
}

/**
 * 设备标识：用于服务端「同一身份最多 5 台设备」的约束（spec §3.5）。
 * 必须持久化，否则每次启动都算新设备，会不断把其他设备挤下线。
 */
export async function loadOrCreateDeviceId(): Promise<string> {
  const SecureStore = await import('expo-secure-store');
  const existing = await SecureStore.getItemAsync(DEVICE_KEY);
  if (existing) {
    return existing;
  }
  const created = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await SecureStore.setItemAsync(DEVICE_KEY, created);
  return created;
}
