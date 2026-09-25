import type { TokenResponse } from '../api/types';
import type { StoredSession, TokenStore } from './tokenStore';

/** 会话彻底失效（刷新令牌也无效），需要重新登录。 */
export class SessionExpiredError extends Error {
  constructor(message = '登录状态已失效，请重新登录') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export interface SessionManagerOptions {
  store: TokenStore;
  refresh: (refreshToken: string) => Promise<TokenResponse>;
  now?: () => number;
}

export function toStoredSession(response: TokenResponse, now: number): StoredSession {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: now + response.expiresIn * 1000,
    accountId: response.identity.accountId,
    identityId: response.identity.identityId,
    identityType: response.identity.identityType,
    orgId: response.identity.orgId,
    nickname: response.identity.nickname,
  };
}

/**
 * 会话管理器：负责「用户无感续期」（spec §3.7）。
 *
 * 两个关键行为：
 * 1. **提前刷新**：剩余有效期不足 {@link SessionManager.REFRESH_SKEW_MS} 时先刷新再发请求。
 * 2. **单飞刷新**：同一时刻只允许一个刷新请求在途，其余调用共享同一个 Promise。
 *
 * 第 2 点是不感知重新登录的核心：冷启动时 App 会并发发起多个请求，
 * 若各自去刷新，服务端轮换会让后到的请求拿着已被换掉的令牌而失败。
 * 服务端侧另有 60 秒轮换宽限期兜底，两层保障叠加。
 */
export class SessionManager {
  static readonly REFRESH_SKEW_MS = 5 * 60 * 1000;

  private session: StoredSession | null = null;
  private inFlight: Promise<StoredSession> | null = null;
  private restored = false;

  constructor(private readonly options: SessionManagerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async restore(): Promise<StoredSession | null> {
    this.session = await this.options.store.read();
    this.restored = true;
    return this.session;
  }

  peek(): StoredSession | null {
    return this.session;
  }

  isAuthenticated(): boolean {
    return this.session !== null;
  }

  /** 登录 / 选定身份 / 切换身份后写入新会话。 */
  async setFromTokenResponse(response: TokenResponse): Promise<StoredSession> {
    const session = toStoredSession(response, this.now());
    this.session = session;
    this.restored = true;
    await this.options.store.write(session);
    return session;
  }

  async clear(): Promise<void> {
    this.session = null;
    this.restored = true;
    await this.options.store.clear();
  }

  /** 返回可用的访问令牌；接近过期时自动静默刷新。 */
  async getAccessToken(): Promise<string | null> {
    if (!this.restored) {
      await this.restore();
    }
    if (!this.session) {
      return null;
    }
    if (!this.isExpiringSoon()) {
      return this.session.accessToken;
    }
    const refreshed = await this.refreshOnce();
    return refreshed.accessToken;
  }

  /** 收到 20001 / 20002 后强制刷新一次（用于重放原请求）。 */
  async forceRefresh(): Promise<StoredSession> {
    if (!this.restored) {
      await this.restore();
    }
    return this.refreshOnce();
  }

  private isExpiringSoon(): boolean {
    if (!this.session) {
      return false;
    }
    return this.session.expiresAt - this.now() <= SessionManager.REFRESH_SKEW_MS;
  }

  private refreshOnce(): Promise<StoredSession> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const current = this.session;
    if (!current) {
      return Promise.reject(new SessionExpiredError());
    }

    const task = (async () => {
      try {
        const response = await this.options.refresh(current.refreshToken);
        return await this.setFromTokenResponse(response);
      } catch (error) {
        // 刷新令牌也失效了，清空会话并要求重新登录
        await this.clear();
        throw error instanceof SessionExpiredError ? error : new SessionExpiredError();
      }
    })();

    this.inFlight = task;
    // 释放单飞锁。用 then(onFulfilled, onRejected) 而非 finally：
    // finally 会把 rejection 传播给派生 promise，不接住就会产生
    // 未处理的 Promise rejection（RN 下可能直接报错）。
    const releaseLock = () => {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    };
    void task.then(releaseLock, releaseLock);
    return task;
  }
}
