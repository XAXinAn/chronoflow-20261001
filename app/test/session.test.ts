import { describe, expect, it, vi } from 'vitest';

import { SessionExpiredError, SessionManager, toStoredSession } from '../src/auth/session';
import { createMemoryTokenStore, type StoredSession } from '../src/auth/tokenStore';
import type { TokenResponse } from '../src/api/types';

const NOW = Date.UTC(2026, 9, 1, 0, 0, 0);

function tokenResponse(accessToken: string, refreshToken: string, expiresIn: number): TokenResponse {
  return {
    accessToken,
    refreshToken,
    expiresIn,
    identity: {
      accountId: 1,
      identityId: 10,
      identityType: 'PERSONAL',
      orgId: null,
      nickname: '测试用户',
    },
  };
}

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW + 2 * 60 * 60 * 1000,
    accountId: 1,
    identityId: 10,
    identityType: 'PERSONAL',
    orgId: null,
    nickname: '测试用户',
    ...overrides,
  };
}

describe('SessionManager', () => {
  it('镜像 setFromTokenResponse：写入存储并换算绝对过期时间', async () => {
    const store = createMemoryTokenStore();
    const session = new SessionManager({ store, refresh: vi.fn(), now: () => NOW });

    await session.setFromTokenResponse(tokenResponse('a', 'r', 7200));

    const persisted = await store.read();
    expect(persisted?.accessToken).toBe('a');
    expect(persisted?.expiresAt).toBe(NOW + 7200 * 1000);
  });

  it('剩余有效期充足时直接复用访问令牌，不触发刷新', async () => {
    const refresh = vi.fn();
    const store = createMemoryTokenStore(storedSession());
    const session = new SessionManager({ store, refresh, now: () => NOW });

    await expect(session.getAccessToken()).resolves.toBe('access-1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('剩余有效期不足 5 分钟时提前静默刷新', async () => {
    const refresh = vi.fn(async () => tokenResponse('access-2', 'refresh-2', 7200));
    const store = createMemoryTokenStore(storedSession({ expiresAt: NOW + 60_000 }));
    const session = new SessionManager({ store, refresh, now: () => NOW });

    await expect(session.getAccessToken()).resolves.toBe('access-2');
    expect(refresh).toHaveBeenCalledExactlyOnceWith('refresh-1');
    expect((await store.read())?.refreshToken).toBe('refresh-2');
  });

  it('并发请求只发起一次刷新（单飞）', async () => {
    // 用闸门 Promise 控制刷新完成时机，验证并发调用共享同一个在途请求
    let release!: (value: TokenResponse) => void;
    const gate = new Promise<TokenResponse>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(() => gate);
    const store = createMemoryTokenStore(storedSession({ expiresAt: NOW + 1000 }));
    const session = new SessionManager({ store, refresh, now: () => NOW });

    // 先完成 restore，使后续并发调用能同步进入刷新分支
    await session.restore();
    const pending = Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    release(tokenResponse('access-9', 'refresh-9', 7200));

    await expect(pending).resolves.toEqual(Array(5).fill('access-9'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('刷新失败时清空会话并抛出需要重新登录', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('20007 刷新令牌无效');
    });
    const store = createMemoryTokenStore(storedSession({ expiresAt: NOW + 1000 }));
    const session = new SessionManager({ store, refresh, now: () => NOW });

    await expect(session.getAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(await store.read()).toBeNull();
    expect(session.isAuthenticated()).toBe(false);
  });

  it('刷新失败后释放单飞锁，后续调用可以再次尝试', async () => {
    let attempt = 0;
    const refresh = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('网络抖动');
      }
      return tokenResponse('access-ok', 'refresh-ok', 7200);
    });
    const store = createMemoryTokenStore(storedSession({ expiresAt: NOW + 1000 }));
    const session = new SessionManager({ store, refresh, now: () => NOW });

    await expect(session.getAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
    // 失败会清空会话，因此需要重新登录后才有令牌
    // 1 分钟有效期（小于 5 分钟提前量）才会触发刷新
    await session.setFromTokenResponse(tokenResponse('access-x', 'refresh-x', 60));
    await expect(session.getAccessToken()).resolves.toBe('access-ok');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('没有会话时 getAccessToken 返回 null，forceRefresh 抛出过期错误', async () => {
    const session = new SessionManager({
      store: createMemoryTokenStore(),
      refresh: vi.fn(),
      now: () => NOW,
    });

    await expect(session.getAccessToken()).resolves.toBeNull();
    await expect(session.forceRefresh()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('toStoredSession 保留身份上下文，供切换组织身份后使用', () => {
    const stored = toStoredSession(
      {
        ...tokenResponse('a', 'r', 100),
        identity: {
          accountId: 7,
          identityId: 77,
          identityType: 'ORG_MEMBER',
          orgId: 900,
          nickname: '员工小张',
        },
      },
      NOW,
    );

    expect(stored).toMatchObject({
      accountId: 7,
      identityId: 77,
      identityType: 'ORG_MEMBER',
      orgId: 900,
      nickname: '员工小张',
    });
  });
});
