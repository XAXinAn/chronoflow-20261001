import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from '../src/api/client';
import { SessionManager } from '../src/auth/session';
import { createMemoryTokenStore, type StoredSession } from '../src/auth/tokenStore';
import type { TokenResponse } from '../src/api/types';

const NOW = Date.UTC(2026, 9, 1, 0, 0, 0);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionWith(overrides: Partial<StoredSession> = {}, refresh?: () => Promise<TokenResponse>) {
  const store = createMemoryTokenStore({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW + 2 * 60 * 60 * 1000,
    accountId: 1,
    identityId: 10,
    identityType: 'PERSONAL',
    orgId: null,
    nickname: '测试',
    ...overrides,
  });
  return new SessionManager({ store, refresh: refresh ?? (async () => {
    throw new Error('不应触发刷新');
  }), now: () => NOW });
}

describe('App API 客户端', () => {
  it('自动附带访问令牌并解包统一响应体', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
      return jsonResponse({ code: 0, message: 'ok', data: [1, 2, 3] });
    });

    const client = createApiClient({
      baseUrl: 'http://api.test',
      session: sessionWith(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get<number[]>('/api/v1/tasks')).resolves.toEqual([1, 2, 3]);
  });

  it('收到 20001 时静默刷新并重放原请求，用户无感知', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (call === 1) {
        expect(auth).toBe('Bearer access-1');
        return jsonResponse({ code: 20001, message: '未登录', data: null });
      }
      // 重放时必须使用刷新后的令牌
      expect(auth).toBe('Bearer access-2');
      return jsonResponse({ code: 0, message: 'ok', data: { ok: true } });
    });

    const session = sessionWith({}, async () => ({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresIn: 7200,
      identity: { accountId: 1, identityId: 10, identityType: 'PERSONAL', orgId: null, nickname: '测试' },
    }));

    const client = createApiClient({
      baseUrl: 'http://api.test',
      session,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get<{ ok: boolean }>('/api/v1/me')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('令牌临近过期且刷新失败时：不发请求，回调 onSessionExpired 并抛出统一错误', async () => {
    const onSessionExpired = vi.fn();
    const fetchImpl = vi.fn();
    const session = sessionWith({ expiresAt: NOW + 1000 }, async () => {
      throw new Error('20007');
    });

    const client = createApiClient({
      baseUrl: 'http://api.test',
      session,
      onSessionExpired,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await client.get('/api/v1/me').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isUnauthenticated).toBe(true);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    // 连鉴权都拿不到，不应该白跑一趟后端
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('服务端返回 20001 且重试时刷新失败：回调 onSessionExpired 并抛出统一错误', async () => {
    const onSessionExpired = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 20001, message: '未登录', data: null }));
    const session = sessionWith({}, async () => {
      throw new Error('20007');
    });

    const client = createApiClient({
      baseUrl: 'http://api.test',
      session,
      onSessionExpired,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await client.get('/api/v1/me').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('20003 无权限不触发刷新，也不清空会话', async () => {
    const onSessionExpired = vi.fn();
    const refresh = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 20003, message: '无权限', data: null }));
    const session = sessionWith({}, refresh as unknown as () => Promise<TokenResponse>);

    const client = createApiClient({
      baseUrl: 'http://api.test',
      session,
      onSessionExpired,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await client.get('/api/v1/org/current').catch((cause: unknown) => cause);
    expect((error as ApiError).isForbidden).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skipAuthRetry 的接口不会触发刷新重放', async () => {
    const refresh = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 20001, message: '未登录', data: null }));
    const session = sessionWith({}, refresh as unknown as () => Promise<TokenResponse>);

    const client = createApiClient({
      baseUrl: 'http://api.test',
      session,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.post('/api/v1/auth/login/sms', {}, { skipAuthRetry: true })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('响应不是 JSON 时给出可读错误', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetchImpl: (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch,
    });

    const error = await client.get('/api/v1/me').catch((cause: unknown) => cause);
    expect((error as ApiError).message).toContain('502');
  });
});
