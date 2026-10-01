import type { ApiClient, TokenProvider } from '../api/client';
import type { OrgAccount, OrgAccountLoginResult, TokenResponse } from '../api/types';

/**
 * 组织账号的「登录记录」（spec §3.2 / §4.2.5）。
 *
 * 一条记录 = 一个已认领的组织账号 + 该组织身份的令牌对。它同时是：
 * - 「账户管理」页要展示的列表；
 * - 进入某个组织视图时用的凭据（不需要重新输组织 ID 与学号）；
 * - 「删除登录记录」要删掉的东西（本地删掉 + 服务端解绑）。
 *
 * 令牌存在安全存储里（与个人会话同一套机制），不进普通存储。
 */

export interface StoredOrgAccount extends OrgAccount {
  accessToken: string;
  refreshToken: string;
  /** 访问令牌的绝对过期时间（毫秒） */
  expiresAt: number;
}

const STORAGE_KEY = 'chronoflow.org-accounts';
/** 与个人会话一致：剩余有效期不足 5 分钟就提前刷新（spec §3.7.2） */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export async function loadOrgAccounts(): Promise<StoredOrgAccount[]> {
  // 动态 import：让本模块在 node 环境下也能被单测直接加载（与 tokenStore 同一手法）
  const SecureStore = await import('expo-secure-store');
  const raw = await SecureStore.getItemAsync(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as StoredOrgAccount[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 存坏了就当没有：组织账号可以重新认领，不值得因此卡住启动
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return [];
  }
}

export async function saveOrgAccounts(accounts: StoredOrgAccount[]): Promise<void> {
  const SecureStore = await import('expo-secure-store');
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(accounts));
}

export function toStoredOrgAccount(
  result: OrgAccountLoginResult,
  now: number = Date.now(),
): StoredOrgAccount {
  return {
    ...result.account,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: now + result.expiresIn * 1000,
  };
}

/** 换一个组织账号的令牌时用它：轮换后的令牌要写回同一条记录。 */
export function applyRefreshedTokens(
  account: StoredOrgAccount,
  tokens: TokenResponse,
  now: number = Date.now(),
): StoredOrgAccount {
  return {
    ...account,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresIn * 1000,
  };
}

export function isAccessTokenFresh(account: StoredOrgAccount, now: number = Date.now()): boolean {
  return now < account.expiresAt - REFRESH_SKEW_MS;
}

/**
 * 给某个组织账号做一个令牌提供者，供 ApiClient 使用。
 *
 * <p>组织上下文的刷新走**裸客户端**（不带会话）：刷新请求本身再带过期令牌会绕成递归。
 */
export function createOrgTokenProvider(options: {
  account: StoredOrgAccount;
  deviceId: string;
  bareClient: ApiClient;
  onRefreshed: (next: StoredOrgAccount) => void | Promise<void>;
}): TokenProvider {
  let current = options.account;

  const refreshOnce = async (): Promise<StoredOrgAccount> => {
    const tokens = await options.bareClient.post<TokenResponse>('/api/v1/auth/token/refresh', {
      refreshToken: current.refreshToken,
      deviceId: options.deviceId,
    });
    current = applyRefreshedTokens(current, tokens);
    await options.onRefreshed(current);
    return current;
  };

  return {
    async getAccessToken() {
      if (isAccessTokenFresh(current)) {
        return current.accessToken;
      }
      return (await refreshOnce()).accessToken;
    },
    async forceRefresh() {
      return refreshOnce();
    },
  };
}
